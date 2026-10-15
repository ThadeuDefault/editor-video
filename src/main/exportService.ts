import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { AudioMixSpec } from '../shared/api'
import { runFfmpeg, spawnFfmpeg } from './ffmpeg'
import { gpuInfo, h264Args } from './gpu'
import { tempDir } from './paths'

const handles = new Map<number, number>()
let nextHandle = 1

export function openVideo(path: string): number {
  const fd = openSync(path, 'w')
  const h = nextHandle++
  handles.set(h, fd)
  return h
}

export function writeVideo(h: number, position: number, data: Uint8Array): void {
  const fd = handles.get(h)
  if (fd === undefined) throw new Error('arquivo de export fechado')
  writeSync(fd, data, 0, data.length, position)
}

export function closeVideo(h: number): void {
  const fd = handles.get(h)
  if (fd !== undefined) closeSync(fd)
  handles.delete(h)
}

// ---- Fallback: frames RGBA brutos enviados ao ffmpeg ----
const raws = new Map<number, { proc: ChildProcess; done: Promise<void> }>()

export async function rawStart(o: { out: string; width: number; height: number; fps: number; bitrate: number }): Promise<number> {
  const { ffmpegH264 } = await gpuInfo()
  const proc = spawnFfmpeg([
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0',
    ...h264Args(ffmpegH264, 'final', o.bitrate), '-pix_fmt', 'yuv420p', '-g', String(Math.round(o.fps * 2)), o.out
  ])
  let err = ''
  proc.stderr!.on('data', (d) => (err += d.toString()))
  const done = new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500)))))
    proc.on('error', reject)
  })
  const h = nextHandle++
  raws.set(h, { proc, done })
  return h
}

export function rawFrame(h: number, rgba: Uint8Array): Promise<void> {
  const r = raws.get(h)
  if (!r) throw new Error('export bruto fechado')
  return new Promise((resolve, reject) => {
    const ok = r.proc.stdin!.write(rgba, (e) => (e ? reject(e) : undefined))
    if (ok) resolve()
    else r.proc.stdin!.once('drain', () => resolve())
  })
}

export async function rawEnd(h: number): Promise<void> {
  const r = raws.get(h)
  if (!r) return
  r.proc.stdin!.end()
  await r.done
  raws.delete(h)
}

const fmt = (n: number) => Math.max(0, n).toFixed(4)

/** Monta o filter_complex de mixagem: cada clipe é recortado, ajustado e posicionado na timeline. */
export function buildAudioFilter(spec: AudioMixSpec): { inputs: string[]; filter: string } {
  const inputs: string[] = []
  const inputIdx = new Map<string, number>()
  const parts: string[] = []
  const labels: string[] = []
  const uses = new Map<number, number>()
  for (const c of spec.clips) {
    if (!inputIdx.has(c.path)) {
      inputIdx.set(c.path, inputs.length)
      inputs.push(c.path)
    }
    const i = inputIdx.get(c.path)!
    uses.set(i, (uses.get(i) || 0) + 1)
  }
  // cada entrada usada N vezes é dividida com asplit
  const splitLabels = new Map<number, string[]>()
  for (const [i, n] of uses) {
    if (n === 1) splitLabels.set(i, [`${i}:a`])
    else {
      const ls = Array.from({ length: n }, (_, k) => `s${i}_${k}`)
      parts.push(`[${i}:a]asplit=${n}${ls.map((l) => `[${l}]`).join('')}`)
      splitLabels.set(i, ls)
    }
  }
  spec.clips.forEach((c, k) => {
    const i = inputIdx.get(c.path)!
    const src = splitLabels.get(i)!.shift()!
    const chain = [`atrim=start=${fmt(c.inPoint)}:end=${fmt(c.inPoint + c.duration)}`, 'asetpts=PTS-STARTPTS']
    if (Math.abs(c.volume - 1) > 1e-3) chain.push(`volume=${fmt(c.volume)}`)
    if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${fmt(c.fadeIn)}`)
    if (c.fadeOut > 0) chain.push(`afade=t=out:st=${fmt(c.duration - c.fadeOut)}:d=${fmt(c.fadeOut)}`)
    const ms = Math.round(c.start * 1000)
    if (ms > 0) chain.push(`adelay=${ms}:all=1`)
    parts.push(`[${src}]${chain.join(',')}[c${k}]`)
    labels.push(`[c${k}]`)
  })
  const n = labels.length
  const tail = `apad,atrim=end=${fmt(spec.duration)},aformat=sample_rates=48000:channel_layouts=stereo[aout]`
  if (n === 0) {
    return { inputs: [], filter: `anullsrc=r=48000:cl=stereo,atrim=end=${fmt(spec.duration)}[aout]` }
  }
  parts.push(n === 1 ? `${labels[0]}${tail}` : `${labels.join('')}amix=inputs=${n}:normalize=0:dropout_transition=0,${tail}`)
  return { inputs, filter: parts.join(';\n') }
}

export async function mixAudio(spec: AudioMixSpec, out: string, onProgress: (p: number) => void): Promise<void> {
  const { inputs, filter } = buildAudioFilter(spec)
  const script = join(tempDir(), `mix-${Date.now()}.txt`)
  writeFileSync(script, filter, 'utf8')
  const args: string[] = ['-loglevel', 'error']
  for (const i of inputs) args.push('-i', i)
  args.push('-/filter_complex', script, '-map', '[aout]', '-c:a', 'pcm_s16le', out)
  await runFfmpeg(args, { duration: spec.duration, onProgress })
}

export async function mux(video: string, audio: string, out: string): Promise<void> {
  await runFfmpeg([
    '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out
  ])
}
