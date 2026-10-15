import type { Draft } from 'immer'
import { coverTransform, splitRect } from '../features/layout'
import { keyframeAt, transformAt, upsertKeyframe } from '../engine/keyframes'
import { baseTextStyle, defaultTransform, newTrack, uid } from './defaults'
import type { AnimProp, AssetInfo, AudioItem, CaptionItem, ImageItem, Item, Keyframe, Project, TextItem, Track, VideoItem } from './types'

type P = Project | Draft<Project>

export function findItem<T extends P>(p: T, id: string): { track: T['tracks'][number]; item: T['tracks'][number]['items'][number]; ti: number; ii: number } | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const ii = p.tracks[ti].items.findIndex((i) => i.id === id)
    if (ii >= 0) return { track: p.tracks[ti], item: p.tracks[ti].items[ii], ti, ii } as never
  }
  return null
}

export function itemEnd(i: Item): number {
  return i.start + i.duration
}

export function overlaps(track: Track | Draft<Track>, start: number, end: number, exclude: string[] = []): boolean {
  return track.items.some((i) => !exclude.includes(i.id) && start < i.start + i.duration - 1e-4 && end > i.start + 1e-4)
}

function sortTrack(t: Draft<Track>): void {
  t.items.sort((a, b) => a.start - b.start)
}

let trackCounter = 1
export function nextTrackName(p: P): string {
  const nums = p.tracks.map((t) => parseInt(/(\d+)$/.exec(t.name)?.[1] || '0', 10))
  trackCounter = Math.max(trackCounter, ...nums) + 1
  return `Faixa ${trackCounter}`
}

/** Coloca o item na faixa; se houver sobreposição cria uma faixa nova acima. Retorna o índice da faixa usada. */
export function placeItem(d: Draft<Project>, item: Item, trackIndex: number): number {
  let ti = Math.max(0, Math.min(trackIndex, d.tracks.length - 1))
  if (!d.tracks.length) {
    d.tracks.push(newTrack(nextTrackName(d)))
    ti = 0
  }
  if (overlaps(d.tracks[ti], item.start, item.start + item.duration)) {
    d.tracks.splice(ti, 0, newTrack(nextTrackName(d)))
  }
  d.tracks[ti].items.push(item as Draft<Item>)
  sortTrack(d.tracks[ti])
  return ti
}

export function makeMediaItem(a: AssetInfo, start: number, W: number, H: number): VideoItem | ImageItem | AudioItem {
  const base = { id: uid(), start, transform: defaultTransform(W, H), keyframes: {} }
  if (a.kind === 'image') return { ...base, type: 'image', assetId: a.id, duration: 5 }
  if (a.kind === 'audio')
    return { ...base, type: 'audio', assetId: a.id, duration: a.duration, inPoint: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }
  return { ...base, type: 'video', assetId: a.id, duration: a.duration, inPoint: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }
}

export function makeTextItem(start: number, W: number, H: number, text = 'SEU TEXTO AQUI'): TextItem {
  return {
    id: uid(),
    type: 'text',
    start,
    duration: 3,
    transform: { ...defaultTransform(W, H), y: H * 0.3 },
    keyframes: {},
    text,
    style: { ...baseTextStyle(), size: 90 },
    maxWidth: W * 0.85
  }
}

/** Duração máxima do item a partir do inPoint (vídeo/áudio limitados pela mídia). */
export function mediaLimit(p: P, it: Item): number {
  if (it.type === 'video' || it.type === 'audio') {
    const a = p.assets.find((x) => x.id === it.assetId)
    return a ? a.duration - it.inPoint : Infinity
  }
  return Infinity
}

function shiftKeyframes(kfs: Item['keyframes'], dt: number, maxT: number): Item['keyframes'] {
  const out: Item['keyframes'] = {}
  for (const k of Object.keys(kfs) as AnimProp[]) {
    const list = (kfs[k] ?? []).map((f) => ({ ...f, t: f.t + dt })).filter((f) => f.t >= -1e-6 && f.t <= maxT + 1e-6)
    if (list.length) out[k] = list
  }
  return out
}

/** Corta o item no tempo t da timeline. Retorna o id da segunda parte. */
export function splitItem(d: Draft<Project>, id: string, t: number): string | null {
  const f = findItem(d, id)
  if (!f) return null
  const it = f.item as Item
  if (t <= it.start + 0.02 || t >= it.start + it.duration - 0.02) return null
  const local = t - it.start
  const right = structuredClone(JSON.parse(JSON.stringify(it))) as Item
  right.id = uid()
  right.start = t
  right.duration = it.duration - local
  // a transformação estática da parte direita é o valor animado no ponto de corte
  const trAt = transformAt(it, local)
  right.transform = { ...trAt }
  right.keyframes = shiftKeyframes(it.keyframes, -local, right.duration)
  for (const k of Object.keys(it.keyframes) as AnimProp[]) {
    if (it.keyframes[k]?.length && right.keyframes[k]) right.keyframes[k] = upsertKeyframe(right.keyframes[k], 0, trAt[k])
  }
  if (right.type === 'video' || right.type === 'audio') {
    right.inPoint = (it as VideoItem).inPoint + local
    ;(right as VideoItem).fadeIn = 0
  }
  if (right.type === 'caption') {
    right.words = (it as CaptionItem).words.filter((w) => w.start >= local - 0.01).map((w) => ({ ...w, start: w.start - local, end: w.end - local }))
  }
  const left = f.item as Draft<Item>
  left.duration = local
  left.keyframes = shiftKeyframes(it.keyframes, 0, local) as never
  if (left.type === 'video' || left.type === 'audio') left.fadeOut = 0
  if (left.type === 'caption') left.words = left.words.filter((w) => w.start < local - 0.01)
  f.track.items.splice(f.ii + 1, 0, right as Draft<Item>)
  return right.id
}

export function deleteItems(d: Draft<Project>, ids: string[], ripple: boolean): void {
  for (const track of d.tracks) {
    const removed = track.items.filter((i) => ids.includes(i.id))
    if (!removed.length) continue
    track.items = track.items.filter((i) => !ids.includes(i.id))
    if (ripple) {
      // fecha os buracos, do fim para o início
      for (const r of [...removed].sort((a, b) => b.start - a.start)) {
        for (const i of track.items) if (i.start >= r.start + r.duration - 1e-4) i.start -= r.duration
      }
    }
  }
}

/** Aplica o corte automático: substitui o item pelos trechos mantidos (tempos de mídia) e fecha os buracos. */
export function applyKeepRanges(d: Draft<Project>, id: string, keep: [number, number][], zoomJumps: boolean): string[] {
  const f = findItem(d, id)
  if (!f) return []
  const it = f.item as VideoItem | AudioItem
  if (it.type !== 'video' && it.type !== 'audio') return []
  const oldEnd = it.start + it.duration
  let cursor = it.start
  const pieces: Item[] = keep.map(([s, e], k) => {
    const piece = JSON.parse(JSON.stringify(it)) as VideoItem
    piece.id = k === 0 ? it.id : uid()
    piece.start = cursor
    piece.inPoint = s
    piece.duration = e - s
    piece.keyframes = {}
    piece.fadeIn = k === 0 ? it.fadeIn : 0
    piece.fadeOut = k === keep.length - 1 ? it.fadeOut : 0
    if (zoomJumps && piece.type === 'video' && k % 2 === 1) piece.transform = { ...piece.transform, scale: piece.transform.scale * 1.08 }
    cursor += e - s
    return piece
  })
  const delta = cursor - oldEnd
  const track = f.track
  for (const i of track.items) if (i.id !== it.id && i.start >= oldEnd - 1e-4) i.start += delta
  track.items.splice(f.ii, 1, ...(pieces as Draft<Item>[]))
  sortTrack(track)
  return pieces.map((p) => p.id)
}

/** Monta a tela dividida com dois vídeos: A em cima, B embaixo. */
export function applySplitScreen(d: Draft<Project>, idA: string, idB: string, ratio = 0.5): void {
  const W = d.settings.width
  const H = d.settings.height
  const fa = findItem(d, idA)
  const fb = findItem(d, idB)
  if (!fa || !fb) return
  const group = uid()
  const a = fa.item as Draft<VideoItem>
  const b = fb.item as Draft<VideoItem>
  let newB: Draft<Item>
  if (fa.ti !== fb.ti && !overlaps(fb.track, a.start, a.start + b.duration, [b.id])) {
    // já estão em faixas diferentes: só alinha o início
    b.start = a.start
    newB = b
  } else {
    // mesma faixa: B vai para uma faixa própria logo acima de A, no mesmo início
    const bCopy = JSON.parse(JSON.stringify(b)) as VideoItem
    fb.track.items.splice(fb.ii, 1)
    bCopy.start = a.start
    const ti = d.tracks.findIndex((t) => t.items.some((i) => i.id === a.id))
    d.tracks.splice(ti, 0, newTrack(nextTrackName(d)))
    d.tracks[ti].items.push(bCopy as Draft<Item>)
    newB = d.tracks[ti].items[d.tracks[ti].items.length - 1]
  }
  newB.keyframes = {}
  if (newB.type === 'video') newB.muted = true
  a.keyframes = {}
  a.layout = { kind: 'split', group, role: 'top', ratio }
  newB.layout = { kind: 'split', group, role: 'bottom', ratio }
  layoutSplitGroup(d, group)
}

export function layoutSplitGroup(d: Draft<Project>, group: string, keepPan = false): void {
  const W = d.settings.width
  const H = d.settings.height
  for (const t of d.tracks)
    for (const it of t.items) {
      if (it.layout?.group !== group || (it.type !== 'video' && it.type !== 'image')) continue
      const a = d.assets.find((x) => x.id === it.assetId)
      if (!a) continue
      const r = splitRect(W, H, it.layout.ratio, it.layout.role)
      it.mask = r
      const cov = coverTransform(a, r, W, H)
      if (keepPan) it.transform = { ...it.transform, scale: Math.max(it.transform.scale, cov.scale), x: cov.x, y: cov.y }
      else it.transform = cov
    }
}

export function removeSplit(d: Draft<Project>, group: string): void {
  for (const t of d.tracks)
    for (const it of t.items)
      if (it.layout?.group === group) {
        delete it.layout
        delete it.mask
        it.transform = defaultTransform(d.settings.width, d.settings.height)
      }
}

/**
 * Define uma propriedade animável. Se a propriedade já tem keyframes (ou autoKey),
 * grava um keyframe no tempo local; senão altera o valor estático.
 */
export function setAnimProp(d: Draft<Project>, id: string, prop: AnimProp, value: number, local: number, forceKey = false): void {
  const f = findItem(d, id)
  if (!f) return
  const it = f.item
  const kfs = it.keyframes[prop] as Keyframe[] | undefined
  if (forceKey || (kfs && kfs.length)) {
    it.keyframes[prop] = upsertKeyframe(kfs, Math.max(0, Math.min(it.duration, local)), value) as never
  } else {
    it.transform[prop] = value
  }
}

export function toggleKeyframe(d: Draft<Project>, id: string, prop: AnimProp, local: number): void {
  const f = findItem(d, id)
  if (!f) return
  const it = f.item
  const list = (it.keyframes[prop] ?? []) as Keyframe[]
  const existing = keyframeAt(list, local)
  if (existing) {
    const rest = list.filter((k) => k !== existing)
    if (rest.length) it.keyframes[prop] = rest as never
    else {
      it.transform[prop] = existing.v
      delete it.keyframes[prop]
    }
  } else {
    const cur = transformAt(it as Item, local)[prop]
    it.keyframes[prop] = upsertKeyframe(list, Math.max(0, Math.min(it.duration, local)), cur) as never
  }
}

export function addCaptionTrack(d: Draft<Project>, items: CaptionItem[], name = 'Legendas'): string {
  const t = newTrack(name)
  t.items = items
  d.tracks.unshift(t as Draft<Track>)
  return t.id
}

/** Fecha buracos: encosta todos os itens da faixa a partir do primeiro. */
export function closeGaps(d: Draft<Project>, trackId: string): void {
  const t = d.tracks.find((x) => x.id === trackId)
  if (!t) return
  sortTrack(t)
  let cursor = t.items[0]?.start ?? 0
  for (const i of t.items) {
    i.start = cursor
    cursor += i.duration
  }
}
