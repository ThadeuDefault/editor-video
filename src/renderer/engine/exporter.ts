import { Muxer, StreamTarget } from 'mp4-muxer'
import { mediaUrl, type AudioMixSpec } from '../../shared/api'
import type { CaptionItem, ImageItem, Project, VideoItem } from '../state/types'
import { activeAt, drawFrame, projectDuration } from './compositor'
import { FrameStream } from './frameReader'
import { fontString } from './textLayout'

export interface ExportOptions {
  out: string
  /** kbps */
  bitrate: number
  fps: number
  /** fator de resolução (1 = resolução do projeto) */
  scale: number
  onProgress: (p: number, label: string) => void
  isCancelled: () => boolean
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export function buildAudioSpec(p: Project): AudioMixSpec {
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const clips: AudioMixSpec['clips'] = []
  for (const tr of p.tracks) {
    if (tr.muted) continue
    for (const it of tr.items) {
      if (it.type !== 'video' && it.type !== 'audio') continue
      const a = assets.get(it.assetId)
      if (!a?.hasAudio || it.muted || it.volume <= 0) continue
      clips.push({ path: a.proxyPath, inPoint: it.inPoint, start: it.start, duration: it.duration, volume: it.volume, fadeIn: it.fadeIn, fadeOut: it.fadeOut })
    }
  }
  return { clips, duration: projectDuration(p) }
}

async function ensureFonts(p: Project): Promise<void> {
  const fonts = new Set<string>()
  for (const t of p.templates) fonts.add(fontString(t.style, 40))
  for (const tr of p.tracks) for (const it of tr.items) if (it.type === 'text') fonts.add(fontString(it.style, 40))
  await Promise.all([...fonts].map((f) => document.fonts.load(f).catch(() => null)))
}

async function pickEncoder(width: number, height: number, bitrate: number, fps: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null
  const codecs = ['avc1.640034', 'avc1.640033', 'avc1.4d0034', 'avc1.42003e']
  for (const hw of ['prefer-hardware', 'no-preference'] as const)
    for (const codec of codecs) {
      const cfg: VideoEncoderConfig = { codec, width, height, bitrate: bitrate * 1000, framerate: fps, hardwareAcceleration: hw, avc: { format: 'avc' }, latencyMode: 'quality', bitrateMode: 'variable' }
      try {
        const r = await VideoEncoder.isConfigSupported(cfg)
        if (r.supported) return cfg
      } catch {
        /* tenta o próximo */
      }
    }
  return null
}

export async function exportProject(p: Project, o: ExportOptions): Promise<void> {
  const api = window.api
  const W = even(p.settings.width * o.scale)
  const H = even(p.settings.height * o.scale)
  const fps = o.fps
  const duration = projectDuration(p)
  if (duration <= 0) throw new Error('A timeline está vazia.')
  const total = Math.max(1, Math.round(duration * fps))
  await ensureFonts(p)

  // imagens
  const bitmaps = new Map<string, ImageBitmap>()
  for (const a of p.assets)
    if (a.kind === 'image') {
      const blob = await (await fetch(mediaUrl(a.proxyPath))).blob()
      bitmaps.set(a.id, await createImageBitmap(blob))
    }

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })!
  const videoTmp = await api.tempPath('video.mp4')
  const audioTmp = await api.tempPath('audio.wav')

  const cfg = await pickEncoder(W, H, o.bitrate, fps)
  const streams = new Map<string, FrameStream>()
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const frames = new Map<string, VideoFrame | null>()
  const src = {
    frame: (item: VideoItem | ImageItem) => (item.type === 'image' ? bitmaps.get(item.assetId) ?? null : frames.get(item.id) ?? null)
  }

  const videoItems: VideoItem[] = []
  for (const tr of p.tracks) if (!tr.hidden) for (const it of tr.items) if (it.type === 'video') videoItems.push(it)

  let writes: Promise<void>[] = []
  let handle = 0
  let rawHandle = 0
  let muxer: Muxer<StreamTarget> | null = null
  let encoder: VideoEncoder | null = null
  let encErr: unknown = null

  if (cfg) {
    handle = await api.exportOpenVideo(videoTmp)
    muxer = new Muxer({
      target: new StreamTarget({ onData: (data, pos) => writes.push(api.exportWriteVideo(handle, pos, data.slice())), chunked: true, chunkSize: 4 * 1024 * 1024 }),
      video: { codec: 'avc', width: W, height: H, frameRate: fps },
      fastStart: false,
      firstTimestampBehavior: 'offset'
    })
    encoder = new VideoEncoder({ output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta), error: (e) => (encErr = e) })
    encoder.configure(cfg)
  } else {
    rawHandle = await api.exportRawStart({ out: videoTmp, width: W, height: H, fps, bitrate: o.bitrate })
  }

  try {
    for (let n = 0; n < total; n++) {
      if (o.isCancelled()) throw new Error('Exportação cancelada.')
      if (encErr) throw encErr
      const t = n / fps
      // abre/fecha leitores conforme os itens entram e saem
      for (const it of videoItems) {
        const on = activeAt(it, t)
        const st = streams.get(it.id)
        if (on && !st) {
          const a = assets.get(it.assetId)
          if (!a) continue
          const fs = new FrameStream(a.proxyPath)
          await fs.open((it.inPoint + (t - it.start)) * 1e6)
          streams.set(it.id, fs)
        } else if (!on && st) {
          st.close()
          streams.delete(it.id)
          frames.delete(it.id)
        }
      }
      for (const [id, st] of streams) {
        const it = videoItems.find((v) => v.id === id)!
        frames.set(id, await st.frameAt((it.inPoint + (t - it.start)) * 1e6))
      }
      drawFrame(ctx, p, t, src, o.scale)
      if (encoder) {
        const vf = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) })
        encoder.encode(vf, { keyFrame: n % Math.round(fps * 2) === 0 })
        vf.close()
        while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2))
        if (writes.length > 32) {
          await Promise.all(writes)
          writes = []
        }
      } else {
        const img = ctx.getImageData(0, 0, W, H)
        await api.exportRawFrame(rawHandle, new Uint8Array(img.data.buffer))
      }
      if (n % 5 === 0) o.onProgress((n / total) * 0.85, `Renderizando vídeo ${n}/${total}`)
    }
    if (encoder) {
      await encoder.flush()
      muxer!.finalize()
      await Promise.all(writes)
      await api.exportCloseVideo(handle)
    } else await api.exportRawEnd(rawHandle)
  } finally {
    streams.forEach((s) => s.close())
    try {
      encoder?.close()
    } catch {
      /* */
    }
    bitmaps.forEach((b) => b.close())
  }

  o.onProgress(0.88, 'Mixando áudio')
  await api.exportMixAudio(buildAudioSpec(p), audioTmp)
  o.onProgress(0.95, 'Finalizando arquivo')
  await api.exportMux(videoTmp, audioTmp, o.out)
  await api.deleteFile(videoTmp)
  await api.deleteFile(audioTmp)
  o.onProgress(1, 'Pronto')
}

export function captionItemsOf(p: Project): CaptionItem[] {
  const out: CaptionItem[] = []
  for (const tr of p.tracks) if (!tr.hidden) for (const it of tr.items) if (it.type === 'caption') out.push(it)
  return out
}
