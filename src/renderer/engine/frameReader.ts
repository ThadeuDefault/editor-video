import { parseMp4, type Sample, type VideoTrackInfo } from './mp4'

const infoCache = new Map<string, Promise<VideoTrackInfo>>()

export function trackInfo(path: string): Promise<VideoTrackInfo> {
  let p = infoCache.get(path)
  if (!p) {
    p = (async () => {
      const size = await window.api.fileSize(path)
      return parseMp4((o, l) => window.api.readRange(path, o, Math.min(l, size - o)), size)
    })()
    infoCache.set(path, p)
  }
  return p
}

/**
 * Lê frames sequenciais (tempos crescentes) de um proxy com WebCodecs.
 * Usado no export: frame exato para cada instante, sem depender de <video>.
 */
export class FrameStream {
  private decoder!: VideoDecoder
  private info!: VideoTrackInfo
  private queue: VideoFrame[] = []
  private current: VideoFrame | null = null
  private next = 0
  private waiters: (() => void)[] = []
  private error: unknown = null
  private flushed = false

  constructor(private path: string) {}

  async open(startUs: number): Promise<void> {
    this.info = await trackInfo(this.path)
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.queue.push(f)
        this.wake()
      },
      error: (e) => {
        this.error = e
        this.wake()
      }
    })
    this.decoder.configure({ codec: this.info.codec, codedWidth: this.info.width, codedHeight: this.info.height, description: this.info.description, hardwareAcceleration: 'no-preference' })
    // começa no keyframe anterior ao ponto pedido
    const s = this.info.samples
    let i = s.findIndex((x) => x.cts > startUs) - 1
    if (i < 0) i = startUs <= 0 ? 0 : s.length - 1
    while (i > 0 && !s[i].key) i--
    this.next = Math.max(0, i)
  }

  private wake(): void {
    const w = this.waiters
    this.waiters = []
    w.forEach((f) => f())
  }

  private wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r))
  }

  /** Lê um lote contíguo de amostras de uma vez (menos chamadas ao disco). */
  private async feed(n: number): Promise<void> {
    const s = this.info.samples
    const end = Math.min(s.length, this.next + n)
    if (this.next >= end) {
      if (!this.flushed) {
        this.flushed = true
        await this.decoder.flush().catch(() => {})
        this.wake()
      }
      return
    }
    const batch: Sample[] = s.slice(this.next, end)
    const lo = Math.min(...batch.map((b) => b.offset))
    const hi = Math.max(...batch.map((b) => b.offset + b.size))
    const data = await window.api.readRange(this.path, lo, hi - lo)
    for (const b of batch) {
      this.decoder.decode(
        new EncodedVideoChunk({ type: b.key ? 'key' : 'delta', timestamp: b.cts, duration: 0, data: data.subarray(b.offset - lo, b.offset - lo + b.size) })
      )
    }
    this.next = end
  }

  /** Frame a exibir no tempo de mídia (µs). Chamadas devem ter tempos crescentes. */
  async frameAt(us: number): Promise<VideoFrame | null> {
    const half = 1000
    for (;;) {
      if (this.error) throw this.error
      // descarta frames que já passaram
      while (this.queue.length && this.queue[0].timestamp <= us + half) {
        this.current?.close()
        this.current = this.queue.shift()!
      }
      const doneDecoding = this.flushed && this.decoder.decodeQueueSize === 0
      if (this.queue.length || doneDecoding) return this.current ?? this.queue[0] ?? null
      if (this.decoder.decodeQueueSize < 6 && !this.flushed) await this.feed(15)
      else await Promise.race([this.wait(), new Promise((r) => setTimeout(r, 50))])
    }
  }

  close(): void {
    this.queue.forEach((f) => f.close())
    this.queue = []
    this.current?.close()
    this.current = null
    try {
      if (this.decoder.state !== 'closed') this.decoder.close()
    } catch {
      /* */
    }
  }
}
