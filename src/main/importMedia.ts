import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { AssetInfo, AssetKind } from '../shared/api'
import { ffprobe, parseRate, runFfmpeg, type ProbeStream } from './ffmpeg'
import { gpuInfo, h264Args } from './gpu'
import { cacheDir } from './paths'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const IMAGE_CONVERT_EXT = new Set(['.heic', '.heif', '.tif', '.tiff', '.avif'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.wma'])
/** versão do formato do cache; mudar invalida proxies antigos */
const CACHE_VERSION = 3
const MAX_SIDE = 1920

function assetId(path: string): string {
  const st = statSync(path)
  return createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|v${CACHE_VERSION}`).digest('hex').slice(0, 16)
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

function rotationOf(s: ProbeStream): number {
  const sd = s.side_data_list?.find((d) => typeof d.rotation === 'number')
  const r = sd?.rotation ?? (s.tags?.rotate ? parseInt(s.tags.rotate, 10) : 0)
  return ((Math.round(r) % 360) + 360) % 360
}

/** Escolhe um fps "limpo" para o proxy CFR. */
function pickFps(s: ProbeStream): { num: string; value: number } {
  let r = parseRate(s.r_frame_rate)
  const avg = parseRate(s.avg_frame_rate)
  if (!r || r > 120) r = avg || 30
  const common: [number, string][] = [
    [23.976, '24000/1001'],
    [24, '24'],
    [25, '25'],
    [29.97, '30000/1001'],
    [30, '30'],
    [50, '50'],
    [59.94, '60000/1001'],
    [60, '60']
  ]
  let best = common[4]
  for (const c of common) if (Math.abs(c[0] - r) < Math.abs(best[0] - r)) best = c
  return { num: best[1], value: parseRate(best[1]) }
}

function hdrChain(s: ProbeStream): string {
  const t = s.color_transfer || ''
  if (t === 'arib-std-b67' || t === 'smpte2084') {
    // HDR (HLG/PQ) -> SDR bt709
    return ',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'
  }
  return ''
}

/** Lê o WAV 16 kHz mono gerado e calcula o RMS a cada 10 ms. */
function computeWave(wavPath: string, outPath: string): void {
  const buf = readFileSync(wavPath)
  // procura o chunk "data"
  let off = 12
  let dataOff = 44
  let dataLen = buf.length - 44
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      dataOff = off + 8
      dataLen = Math.min(len, buf.length - dataOff)
      break
    }
    off += 8 + len + (len % 2)
  }
  const samples = Math.floor(dataLen / 2)
  const win = 160 // 10 ms a 16 kHz
  const n = Math.ceil(samples / win)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    const s0 = i * win
    const s1 = Math.min(samples, s0 + win)
    for (let s = s0; s < s1; s++) {
      const v = buf.readInt16LE(dataOff + s * 2) / 32768
      sum += v * v
    }
    out[i] = Math.sqrt(sum / Math.max(1, s1 - s0))
  }
  writeFileSync(outPath, Buffer.from(out.buffer))
}

const inflight = new Map<string, Promise<AssetInfo>>()

export function importMedia(path: string, onProgress: (p: number, label: string) => void): Promise<AssetInfo> {
  const id = assetId(path)
  let p = inflight.get(id)
  if (!p) {
    p = doImport(path, id, onProgress).finally(() => inflight.delete(id))
    inflight.set(id, p)
  }
  return p
}

async function doImport(path: string, id: string, onProgress: (p: number, label: string) => void): Promise<AssetInfo> {
  const dir = join(cacheDir(), id)
  const metaPath = join(dir, 'meta.json')
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AssetInfo
      // a pasta do programa pode ter sido movida: reancora os arquivos do cache nesta pasta
      for (const k of ['proxyPath', 'wavPath', 'wavePath'] as const) {
        const p = meta[k]
        if (p && !existsSync(p) && existsSync(join(dir, basename(p)))) meta[k] = join(dir, basename(p))
      }
      if (existsSync(meta.proxyPath)) {
        writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8')
        return meta
      }
    } catch {
      /* refaz */
    }
  }
  mkdirSync(dir, { recursive: true })
  const ext = extname(path).toLowerCase()
  const probe = await ffprobe(path)
  const vStream = probe.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const aStream = probe.streams.find((s) => s.codec_type === 'audio')
  const duration = parseFloat(probe.format.duration || vStream?.duration || aStream?.duration || '0') || 0

  let kind: AssetKind
  if (IMAGE_EXT.has(ext) || IMAGE_CONVERT_EXT.has(ext)) kind = 'image'
  else if (!vStream || AUDIO_EXT.has(ext)) kind = 'audio'
  else if (vStream && (!duration || duration < 0.05) && !aStream) kind = 'image'
  else kind = 'video'

  const info: AssetInfo = {
    id,
    name: basename(path),
    originalPath: path,
    proxyPath: '',
    kind,
    duration: kind === 'image' ? 0 : duration,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: !!aStream && kind !== 'image'
  }

  if (kind === 'image') {
    let w = vStream?.width || 0
    let h = vStream?.height || 0
    if (IMAGE_CONVERT_EXT.has(ext) || !w) {
      const out = join(dir, 'imagem.png')
      await runFfmpeg(['-loglevel', 'error', '-i', path, '-frames:v', '1', out])
      info.proxyPath = out
      const p2 = await ffprobe(out)
      w = p2.streams[0]?.width || w
      h = p2.streams[0]?.height || h
    } else info.proxyPath = path
    info.width = w
    info.height = h
  } else if (kind === 'video') {
    const s = vStream!
    const rot = rotationOf(s)
    let w = s.width || 1080
    let h = s.height || 1920
    if (rot === 90 || rot === 270) [w, h] = [h, w]
    const f = Math.min(1, MAX_SIDE / Math.max(w, h))
    const tw = even(w * f)
    const th = even(h * f)
    const fps = pickFps(s)
    info.width = tw
    info.height = th
    info.fps = fps.value
    const { ffmpegH264 } = await gpuInfo()
    const tmp = join(dir, 'proxy.tmp.mp4')
    const out = join(dir, 'proxy.mp4')
    const vf = (enc: string) =>
      `scale=${tw}:${th}:flags=bicubic${hdrChain(s)},format=${enc === 'h264_qsv' ? 'nv12' : 'yuv420p'},fps=${fps.num},setsar=1`
    const baseArgs = (enc: string) => [
      '-loglevel', 'error', '-hwaccel', 'auto', '-i', path,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf(enc),
      ...h264Args(enc, 'proxy'), '-g', '15', '-bf', '0',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-video_track_timescale', '90000', tmp
    ]
    const progress = (p: number) => onProgress(p * 0.9, 'Convertendo vídeo')
    try {
      await runFfmpeg(baseArgs(ffmpegH264), { duration, onProgress: progress })
    } catch (e) {
      if (ffmpegH264 === 'libx264') throw e
      await runFfmpeg(baseArgs('libx264'), { duration, onProgress: progress })
    }
    renameSync(tmp, out)
    info.proxyPath = out
  } else {
    const out = join(dir, 'audio.m4a')
    await runFfmpeg(['-loglevel', 'error', '-i', path, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out], {
      duration,
      onProgress: (p) => onProgress(p * 0.9, 'Convertendo áudio')
    })
    info.proxyPath = out
  }

  if (info.hasAudio) {
    onProgress(0.92, 'Analisando áudio')
    const wav = join(dir, 'audio16k.wav')
    await runFfmpeg(['-loglevel', 'error', '-i', info.proxyPath, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav])
    const wave = join(dir, 'onda.f32')
    computeWave(wav, wave)
    info.wavPath = wav
    info.wavePath = wave
  }
  // duração real do proxy (pode diferir levemente do original)
  if (kind !== 'image') {
    const p2 = await ffprobe(info.proxyPath)
    const d = parseFloat(p2.format.duration || '0')
    if (d > 0) info.duration = d
  }
  writeFileSync(metaPath, JSON.stringify(info, null, 2), 'utf8')
  onProgress(1, 'Pronto')
  return info
}

export function clearCache(): number {
  const dir = cacheDir()
  let freed = 0
  const walk = (d: string): number => {
    let total = 0
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      const st = statSync(p)
      total += st.isDirectory() ? walk(p) : st.size
    }
    return total
  }
  try {
    freed = walk(dir)
  } catch {
    /* */
  }
  rmSync(dir, { recursive: true, force: true })
  return freed
}
