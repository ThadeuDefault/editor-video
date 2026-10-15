import { mediaUrl } from '../../shared/api'
import { ed, useEditor } from '../state/store'
import type { AudioItem, ImageItem, Item, Project, VideoItem } from '../state/types'
import { drawFrame, projectDuration } from './compositor'

type MediaItem = VideoItem | AudioItem

interface Slot {
  el: HTMLMediaElement
  gain: GainNode
  assetId: string
  itemId: string | null
  /** última busca pedida (evita repetir seek enquanto ainda busca) */
  pendingSeek: number
}

const LOOKAHEAD = 1.0

function fadeGain(it: MediaItem, local: number): number {
  let g = 1
  if (it.fadeIn > 0 && local < it.fadeIn) g *= Math.max(0, local / it.fadeIn)
  if (it.fadeOut > 0 && local > it.duration - it.fadeOut) g *= Math.max(0, (it.duration - local) / it.fadeOut)
  return g
}

/**
 * Preview: relógio próprio + pool de elementos <video>/<audio> por mídia.
 * Itens que vão começar em breve recebem um elemento já posicionado (sem engasgo nos cortes).
 */
export class PreviewEngine {
  private ctx: CanvasRenderingContext2D
  private audio: AudioContext | null = null
  private slots: Slot[] = []
  private images = new Map<string, HTMLImageElement>()
  private raf = 0
  private dirty = true
  private startWall = 0
  private startT = 0
  private unsub: () => void
  private lastStoreTime = -1
  scale = 0.5

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!
    ;(window as unknown as { __engine: PreviewEngine }).__engine = this
    this.unsub = useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project || s.time !== prev.time) this.dirty = true
      if (s.playing !== prev.playing) s.playing ? this.onPlay() : this.onPause()
      if (s.playing && prev.playing && s.time !== prev.time && s.time !== this.lastStoreTime) this.resync(s.time)
    })
    document.fonts.addEventListener('loadingdone', () => (this.dirty = true))
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.unsub()
    for (const s of this.slots) {
      s.el.pause()
      s.el.removeAttribute('src')
      s.el.load()
    }
    this.slots = []
    this.audio?.close()
  }

  invalidate(): void {
    this.dirty = true
  }

  setSize(w: number, h: number, scale: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.scale = scale
    this.dirty = true
  }

  private ensureAudio(): AudioContext {
    if (!this.audio) this.audio = new AudioContext({ latencyHint: 'interactive' })
    if (this.audio.state === 'suspended') this.audio.resume()
    return this.audio
  }

  private onPlay(): void {
    this.ensureAudio()
    const s = ed()
    const dur = projectDuration(s.project)
    if (s.time >= dur - 0.05) s.set({ time: 0 })
    this.startT = ed().time
    this.startWall = performance.now()
  }

  private onPause(): void {
    for (const s of this.slots) s.el.pause()
    this.dirty = true
  }

  private acquire(assetId: string, path: string, kind: 'video' | 'audio', itemId: string): Slot {
    let slot = this.slots.find((s) => s.itemId === itemId)
    if (slot) return slot
    slot = this.slots.find((s) => s.assetId === assetId && s.itemId === null)
    if (!slot) {
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video') as HTMLMediaElement
      el.crossOrigin = 'anonymous'
      el.preload = 'auto'
      ;(el as HTMLVideoElement).playsInline = true
      el.src = mediaUrl(path)
      const actx = this.ensureAudio()
      const node = actx.createMediaElementSource(el)
      const gain = actx.createGain()
      node.connect(gain).connect(actx.destination)
      el.addEventListener('seeked', () => (this.dirty = true))
      el.addEventListener('loadeddata', () => (this.dirty = true))
      slot = { el, gain, assetId, itemId: null, pendingSeek: -1 }
      this.slots.push(slot)
    }
    slot.itemId = itemId
    return slot
  }

  private image(assetId: string, path: string): HTMLImageElement | null {
    let img = this.images.get(assetId)
    if (!img) {
      img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => (this.dirty = true)
      img.src = mediaUrl(path)
      this.images.set(assetId, img)
    }
    return img.complete && img.naturalWidth ? img : null
  }

  private seek(slot: Slot, t: number): void {
    if (Math.abs(slot.pendingSeek - t) < 1e-3 && (slot.el as HTMLVideoElement).seeking) return
    slot.pendingSeek = t
    slot.el.currentTime = Math.max(0, t)
  }

  /** Sincroniza os elementos de mídia com o tempo t. */
  private sync(p: Project, t: number, playing: boolean): void {
    const assets = new Map(p.assets.map((a) => [a.id, a]))
    const wanted = new Set<string>()
    for (const tr of p.tracks) {
      for (const it of tr.items) {
        if (it.type !== 'video' && it.type !== 'audio') continue
        const end = it.start + it.duration
        const active = t >= it.start && t < end
        const upcoming = !active && it.start > t && it.start - t < LOOKAHEAD && playing
        if (!active && !upcoming) continue
        if (it.type === 'video' && tr.hidden && (it.muted || tr.muted)) continue
        const a = assets.get(it.assetId)
        if (!a) continue
        wanted.add(it.id)
        const slot = this.acquire(a.id, a.proxyPath, it.type, it.id)
        const local = active ? t - it.start : 0
        const target = it.inPoint + local
        const vol = tr.muted || it.muted ? 0 : it.volume * fadeGain(it, local)
        slot.gain.gain.value = vol
        if (!active) {
          if (!slot.el.paused) slot.el.pause()
          if (Math.abs(slot.el.currentTime - target) > 0.05) this.seek(slot, target)
          continue
        }
        if (playing) {
          if (slot.el.paused) {
            if (Math.abs(slot.el.currentTime - target) > 0.04) this.seek(slot, target)
            slot.el.play().catch(() => {})
          } else if (Math.abs(slot.el.currentTime - target) > 0.15) this.seek(slot, target)
        } else {
          if (!slot.el.paused) slot.el.pause()
          const tol = 0.5 / (p.settings.fps || 30)
          if (Math.abs(slot.el.currentTime - target) > tol) this.seek(slot, target)
        }
      }
    }
    for (const s of this.slots) {
      if (s.itemId && !wanted.has(s.itemId)) {
        s.el.pause()
        s.itemId = null
      }
    }
    // limita o pool
    if (this.slots.length > 24) {
      const free = this.slots.filter((s) => !s.itemId)
      for (const s of free.slice(0, this.slots.length - 24)) {
        s.el.removeAttribute('src')
        s.el.load()
        this.slots.splice(this.slots.indexOf(s), 1)
      }
    }
  }

  private frameOf = (item: VideoItem | ImageItem): CanvasImageSource | null => {
    const p = ed().project
    if (item.type === 'image') {
      const a = p.assets.find((x) => x.id === item.assetId)
      return a ? this.image(a.id, a.proxyPath) : null
    }
    const slot = this.slots.find((s) => s.itemId === item.id)
    if (!slot) return null
    const v = slot.el as HTMLVideoElement
    return v.readyState >= 2 ? v : null
  }

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop)
    const s = ed()
    let t = s.time
    if (s.playing) {
      t = this.startT + (performance.now() - this.startWall) / 1000
      const dur = projectDuration(s.project)
      if (t >= dur) {
        t = dur
        s.set({ playing: false, time: dur })
      } else {
        this.lastStoreTime = t
        s.set({ time: t })
      }
      this.dirty = true
    }
    this.sync(s.project, t, s.playing)
    if (!this.dirty) return
    this.dirty = false
    drawFrame(this.ctx, s.project, t, { frame: this.frameOf }, this.scale)
    // enquanto algum vídeo ainda busca, redesenha de novo
    if (this.slots.some((sl) => sl.itemId && (sl.el as HTMLVideoElement).seeking)) this.dirty = true
  }

  /** Reposiciona o relógio (quando o usuário clica na timeline durante a reprodução). */
  resync(t: number): void {
    this.startT = t
    this.startWall = performance.now()
  }
}

export const isMedia = (i: Item): i is MediaItem => i.type === 'video' || i.type === 'audio'
