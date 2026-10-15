import type { AssetInfo, CaptionItem, CaptionTemplate, ImageItem, Item, Project, TextItem, VideoItem } from '../state/types'
import { captionBounds, drawCaption, drawTextItem, textItemLayout } from './captionRender'
import { transformAt } from './keyframes'
import type { Ctx2D } from './textLayout'

export interface FrameSource {
  /** imagem do item no tempo de mídia pedido; null se ainda não disponível */
  frame(item: VideoItem | ImageItem, mediaTime: number): CanvasImageSource | null
}

export function isVisual(item: Item): item is VideoItem | ImageItem | TextItem | CaptionItem {
  return item.type !== 'audio'
}

export function activeAt(item: Item, t: number): boolean {
  return t >= item.start - 1e-6 && t < item.start + item.duration - 1e-6
}

export function projectDuration(p: Project): number {
  let d = 0
  for (const tr of p.tracks) for (const it of tr.items) d = Math.max(d, it.start + it.duration)
  return d
}

/** Tamanho base (escala 1) de uma mídia: encaixada (contain) no quadro. */
export function baseSize(a: Pick<AssetInfo, 'width' | 'height'>, W: number, H: number): { w: number; h: number } {
  if (!a.width || !a.height) return { w: W, h: H }
  const f = Math.min(W / a.width, H / a.height)
  return { w: a.width * f, h: a.height * f }
}

export function templateOf(p: Project, id: string): CaptionTemplate {
  return p.templates.find((t) => t.id === id) ?? p.templates[0]
}

/** Caixa (antes da rotação) do item em coordenadas do projeto. */
export function itemBox(ctx: Ctx2D, p: Project, item: Item, t: number): { cx: number; cy: number; w: number; h: number; rotation: number } | null {
  const W = p.settings.width
  const H = p.settings.height
  const tr = transformAt(item, t - item.start)
  if (item.type === 'video' || item.type === 'image') {
    const a = p.assets.find((x) => x.id === item.assetId)
    if (!a) return null
    const b = baseSize(a, W, H)
    return { cx: tr.x, cy: tr.y, w: b.w * tr.scale, h: b.h * tr.scale, rotation: tr.rotation }
  }
  if (item.type === 'text') {
    const L = textItemLayout(ctx, item)
    return { cx: tr.x, cy: tr.y, w: L.width * tr.scale, h: L.height * tr.scale, rotation: tr.rotation }
  }
  if (item.type === 'caption') {
    const b = captionBounds(ctx, item, templateOf(p, item.templateId), W, H)
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h, rotation: 0 }
  }
  return null
}

export function drawFrame(ctx: Ctx2D, p: Project, t: number, src: FrameSource, scale = 1): void {
  const W = p.settings.width
  const H = p.settings.height
  ctx.save()
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = p.settings.background || '#000'
  ctx.fillRect(0, 0, W, H)
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
    const track = p.tracks[ti]
    if (track.hidden) continue
    for (const item of track.items) {
      if (!isVisual(item) || !activeAt(item, t)) continue
      const local = t - item.start
      if (item.type === 'caption') {
        drawCaption(ctx, item, templateOf(p, item.templateId), local, W, H, transformAt(item, local).opacity)
        continue
      }
      const tr = transformAt(item, local)
      if (tr.opacity <= 0.001) continue
      ctx.save()
      if (item.mask) {
        ctx.beginPath()
        ctx.rect(item.mask.x, item.mask.y, item.mask.w, item.mask.h)
        ctx.clip()
      }
      ctx.globalAlpha = Math.min(1, tr.opacity)
      ctx.translate(tr.x, tr.y)
      if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180)
      if (tr.scale !== 1) ctx.scale(tr.scale, tr.scale)
      if (item.type === 'text') drawTextItem(ctx, item)
      else {
        const a = assets.get(item.assetId)
        if (a) {
          const media = item.type === 'video' ? item.inPoint + local : 0
          const img = src.frame(item, media)
          if (img) {
            const b = baseSize(a, W, H)
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(img, -b.w / 2, -b.h / 2, b.w, b.h)
          }
        }
      }
      ctx.restore()
    }
  }
  ctx.restore()
}
