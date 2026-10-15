import type { CaptionItem, CaptionTemplate, TextItem } from '../state/types'
import { applyCase, drawTextLayout, layoutText, type Ctx2D, type TextLayout, type WordFx } from './textLayout'

/** Fatores de escala: modelos são definidos para 1080x1920. */
export function templateScale(W: number, H: number): { size: number; bottom: number } {
  return { size: Math.min(W, H) / 1080, bottom: H / 1920 }
}

const layoutCache = new WeakMap<object, { key: string; layout: TextLayout }>()

function cached(obj: object, key: string, make: () => TextLayout): TextLayout {
  const c = layoutCache.get(obj)
  if (c && c.key === key) return c.layout
  const layout = make()
  layoutCache.set(obj, { key, layout })
  return layout
}

function easeOutBack(x: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}

function animFx(type: CaptionTemplate['animation']['type'], p: number): WordFx {
  if (p >= 1) return {}
  const q = Math.max(0, p)
  switch (type) {
    case 'pop':
      return { scale: 0.6 + 0.4 * easeOutBack(q), alpha: Math.min(1, q * 3) }
    case 'bounce':
      return { scale: 1 + 0.25 * Math.sin(q * Math.PI) * (1 - q), alpha: Math.min(1, q * 4), dy: -20 * Math.sin(q * Math.PI) }
    case 'fade':
      return { alpha: q }
    case 'slide':
      return { alpha: q, dy: 40 * (1 - (1 - Math.pow(1 - q, 3))) }
    default:
      return {}
  }
}

/** Índice da palavra falada em t (tempo local); -1 antes da primeira. */
export function activeWordIndex(words: CaptionItem['words'], t: number): number {
  let idx = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i].start <= t + 1e-4) idx = i
    else break
  }
  return idx
}

export function captionBounds(ctx: Ctx2D, item: CaptionItem, tpl: CaptionTemplate, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const L = captionLayout(ctx, item, tpl, W, H)
  const k = templateScale(W, H)
  const top = H - tpl.marginBottom * k.bottom - L.height
  return { x: W / 2 - L.width / 2, y: top, w: L.width, h: L.height }
}

function captionLayout(ctx: Ctx2D, item: CaptionItem, tpl: CaptionTemplate, W: number, H: number): TextLayout {
  const k = templateScale(W, H)
  const tokens = item.words.map((w) => applyCase(w.text, tpl.style))
  const maxW = W - 2 * tpl.marginX * k.size
  return cached(item, `${tokens.join(' ')}|${JSON.stringify(tpl)}|${W}x${H}`, () => layoutText(ctx, tokens, tpl.style, maxW, tpl.maxLines, k.size))
}

/** Desenha um bloco de legenda; `local` = segundos desde o início do item. */
export function drawCaption(ctx: Ctx2D, item: CaptionItem, tpl: CaptionTemplate, local: number, W: number, H: number, opacity = 1): void {
  if (!item.words.length) return
  const L = captionLayout(ctx, item, tpl, W, H)
  const k = templateScale(W, H)
  const top = H - tpl.marginBottom * k.bottom - L.height
  const active = activeWordIndex(item.words, local)
  const anim = tpl.animation
  const blockFx = anim.target === 'block' && anim.type !== 'none' ? animFx(anim.type, local / Math.max(0.01, anim.duration)) : {}

  ctx.save()
  ctx.globalAlpha = opacity * (blockFx.alpha ?? 1)
  ctx.translate(W / 2, top + L.height / 2 + (blockFx.dy ?? 0) * k.size)
  if (blockFx.scale && blockFx.scale !== 1) ctx.scale(blockFx.scale, blockFx.scale)
  ctx.translate(0, -L.height / 2)
  drawTextLayout(
    ctx,
    L,
    tpl.style,
    (i) => {
      const w = item.words[i]
      const fx: WordFx = {}
      if (anim.target === 'word' && anim.type !== 'none') {
        if (local < w.start) return { alpha: 0 }
        Object.assign(fx, animFx(anim.type, (local - w.start) / Math.max(0.01, anim.duration)))
        if (fx.dy) fx.dy *= k.size
      }
      const isActive = i === active
      if (tpl.highlight.enabled && isActive) {
        fx.color = tpl.highlight.color
        fx.scale = (fx.scale ?? 1) * tpl.highlight.scale
      }
      if (tpl.style.box.mode === 'word' && isActive) fx.box = tpl.highlight.boxColor || tpl.style.box.color
      return fx
    },
    k.size
  )
  ctx.restore()
}

export function textItemLayout(ctx: Ctx2D, item: TextItem): TextLayout {
  const tokens: string[] = []
  applyCase(item.text, item.style)
    .split('\n')
    .forEach((para, i) => {
      if (i) tokens.push('\n')
      tokens.push(...para.split(/\s+/).filter(Boolean))
    })
  return cached(item, `${tokens.join(' ')}|${JSON.stringify(item.style)}|${item.maxWidth}`, () => layoutText(ctx, tokens, item.style, item.maxWidth, 0, 1))
}

/** Texto livre: desenhado centrado na origem atual (o compositor já aplicou a transformação). */
export function drawTextItem(ctx: Ctx2D, item: TextItem): { w: number; h: number } {
  const L = textItemLayout(ctx, item)
  ctx.save()
  ctx.translate(0, -L.height / 2)
  drawTextLayout(ctx, L, item.style)
  ctx.restore()
  return { w: L.width, h: L.height }
}
