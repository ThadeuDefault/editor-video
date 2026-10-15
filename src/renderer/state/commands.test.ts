import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { applyKeepRanges, applySplitScreen, deleteItems, makeMediaItem, placeItem, splitItem } from './commands'
import { newProject } from './defaults'
import { interpolate, transformAt } from '../engine/keyframes'
import type { AssetInfo, VideoItem } from './types'

const asset: AssetInfo = { id: 'a', name: 'v', originalPath: '', proxyPath: '', kind: 'video', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true }
const asset2: AssetInfo = { ...asset, id: 'b', width: 1920, height: 1080 }

function base() {
  const p = newProject()
  p.assets.push(asset, asset2)
  return produce(p, (d) => {
    placeItem(d, makeMediaItem(asset, 0, 1080, 1920), 0)
  })
}

describe('comandos', () => {
  it('divide no cursor mantendo o inPoint', () => {
    const p = base()
    const id = p.tracks[0].items[0].id
    const q = produce(p, (d) => void splitItem(d, id, 4))
    const [a, b] = q.tracks[0].items as VideoItem[]
    expect(a.duration).toBeCloseTo(4)
    expect(b.start).toBeCloseTo(4)
    expect(b.inPoint).toBeCloseTo(4)
    expect(b.duration).toBeCloseTo(6)
  })
  it('sobreposição cria faixa nova', () => {
    const p = base()
    const q = produce(p, (d) => void placeItem(d, makeMediaItem(asset, 2, 1080, 1920), 0))
    expect(q.tracks.length).toBe(2)
  })
  it('corte automático encosta os trechos e puxa o resto', () => {
    let p = base()
    p = produce(p, (d) => void placeItem(d, { ...makeMediaItem(asset, 10, 1080, 1920), duration: 2 }, 0))
    const id = p.tracks[0].items[0].id
    const q = produce(p, (d) => void applyKeepRanges(d, id, [[1, 3], [5, 6]], true))
    const items = q.tracks[0].items as VideoItem[]
    expect(items.length).toBe(3)
    expect(items[1].start).toBeCloseTo(2)
    expect(items[1].inPoint).toBeCloseTo(5)
    expect(items[1].transform.scale).toBeCloseTo(1.08)
    expect(items[2].start).toBeCloseTo(3)
  })
  it('excluir com ripple fecha o buraco', () => {
    let p = base()
    p = produce(p, (d) => void placeItem(d, { ...makeMediaItem(asset, 10, 1080, 1920), duration: 2 }, 0))
    const first = p.tracks[0].items[0].id
    const q = produce(p, (d) => deleteItems(d, [first], true))
    expect(q.tracks[0].items[0].start).toBeCloseTo(0)
  })
  it('tela dividida: máscaras em cima e embaixo', () => {
    let p = base()
    p = produce(p, (d) => void placeItem(d, makeMediaItem(asset2, 0, 1080, 1920), 0))
    const ids = p.tracks.flatMap((t) => t.items.map((i) => i.id))
    const q = produce(p, (d) => applySplitScreen(d, ids[1], ids[0]))
    const items = q.tracks.flatMap((t) => t.items)
    const top = items.find((i) => i.layout?.role === 'top')!
    const bot = items.find((i) => i.layout?.role === 'bottom')!
    expect(top.mask).toEqual({ x: 0, y: 0, w: 1080, h: 960 })
    expect(bot.mask).toEqual({ x: 0, y: 960, w: 1080, h: 960 })
    expect(top.start).toBe(bot.start)
    // vertical cobre a metade com escala 1; horizontal precisa ampliar
    expect(top.transform.scale).toBeCloseTo(1)
    expect(bot.transform.scale).toBeGreaterThan(1.5)
  })
})

describe('keyframes', () => {
  it('interpola linear e segura', () => {
    expect(interpolate([{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 10, ease: 'linear' }], 1)).toBeCloseTo(5)
    expect(interpolate([{ t: 0, v: 0, ease: 'hold' }, { t: 2, v: 10, ease: 'linear' }], 1.9)).toBeCloseTo(0)
    expect(interpolate([{ t: 1, v: 3, ease: 'linear' }], 0)).toBe(3)
  })
  it('transformAt usa keyframes quando existem', () => {
    const it0 = { ...makeMediaItem(asset, 0, 1080, 1920), keyframes: { scale: [{ t: 0, v: 1, ease: 'linear' as const }, { t: 1, v: 2, ease: 'linear' as const }] } }
    expect(transformAt(it0, 0.5).scale).toBeCloseTo(1.5)
    expect(transformAt(it0, 0.5).x).toBe(540)
  })
})
