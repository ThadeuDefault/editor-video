import type { TextStyle } from '../state/types'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface LaidWord {
  text: string
  /** índice da palavra original */
  index: number
  /** canto esquerdo, relativo ao centro horizontal do bloco */
  x: number
  /** centro vertical da linha, relativo ao topo do bloco */
  y: number
  w: number
  line: number
}

export interface TextLayout {
  words: LaidWord[]
  lines: { y: number; x0: number; x1: number }[]
  width: number
  height: number
  size: number
  lineHeight: number
}

export function fontString(s: TextStyle, size: number): string {
  return `${s.italic ? 'italic ' : ''}${s.weight} ${size}px "${s.font}", "Inter", "Segoe UI", sans-serif`
}

export function applyCase(text: string, s: TextStyle): string {
  return s.uppercase ? text.toLocaleUpperCase('pt-BR') : text
}

function setFont(ctx: Ctx2D, s: TextStyle, size: number): void {
  ctx.font = fontString(s, size)
  ;(ctx as CanvasRenderingContext2D).letterSpacing = `${s.letterSpacing || 0}px`
}

/**
 * Distribui as palavras em linhas. Token '\n' força quebra.
 * Com maxLines definido, reduz a fonte até caber e equilibra 2 linhas.
 */
export function layoutText(ctx: Ctx2D, tokens: string[], s: TextStyle, maxWidth: number, maxLines = 0, sizeScale = 1): TextLayout {
  let size = s.size * sizeScale
  const minSize = size * 0.55
  let lines: number[][] = []
  let widths: number[] = []
  let spaceW = 0
  for (let attempt = 0; attempt < 12; attempt++) {
    setFont(ctx, s, size)
    spaceW = ctx.measureText(' ').width
    widths = tokens.map((t) => (t === '\n' ? 0 : ctx.measureText(t).width))
    lines = greedy(tokens, widths, spaceW, maxWidth)
    if (maxLines === 2 && lines.length === 2 && !tokens.includes('\n')) lines = balance(lines.flat(), widths, spaceW, maxWidth) ?? lines
    if (!maxLines || lines.length <= maxLines || size <= minSize) break
    size *= 0.92
  }
  const lh = size * s.lineHeight
  const words: LaidWord[] = []
  const outLines: TextLayout['lines'] = []
  let maxW = 0
  lines.forEach((ln, li) => {
    const lw = ln.reduce((a, i, k) => a + widths[i] + (k ? spaceW : 0), 0)
    maxW = Math.max(maxW, lw)
    let x = s.align === 'left' ? -maxWidth / 2 : s.align === 'right' ? maxWidth / 2 - lw : -lw / 2
    const y = li * lh + lh / 2
    const x0 = x
    ln.forEach((i, k) => {
      if (k) x += spaceW
      words.push({ text: tokens[i], index: i, x, y, w: widths[i], line: li })
      x += widths[i]
    })
    outLines.push({ y, x0, x1: x })
  })
  return { words, lines: outLines, width: maxW, height: lines.length * lh, size, lineHeight: lh }
}

function greedy(tokens: string[], widths: number[], spaceW: number, maxWidth: number): number[][] {
  const lines: number[][] = []
  let cur: number[] = []
  let curW = 0
  tokens.forEach((t, i) => {
    if (t === '\n') {
      lines.push(cur)
      cur = []
      curW = 0
      return
    }
    const add = (cur.length ? spaceW : 0) + widths[i]
    if (cur.length && curW + add > maxWidth) {
      lines.push(cur)
      cur = [i]
      curW = widths[i]
    } else {
      cur.push(i)
      curW += add
    }
  })
  if (cur.length || !lines.length) lines.push(cur)
  return lines.filter((l, k) => l.length || k === 0)
}

/** Divide em 2 linhas minimizando a linha mais larga. */
function balance(idx: number[], widths: number[], spaceW: number, maxWidth: number): number[][] | null {
  let best: number[][] | null = null
  let bestW = Infinity
  const w = (a: number[]) => a.reduce((s, i, k) => s + widths[i] + (k ? spaceW : 0), 0)
  for (let cut = 1; cut < idx.length; cut++) {
    const a = idx.slice(0, cut)
    const b = idx.slice(cut)
    const m = Math.max(w(a), w(b))
    if (m <= maxWidth && m < bestW) {
      bestW = m
      best = [a, b]
    }
  }
  return best
}

export interface WordFx {
  alpha?: number
  scale?: number
  dy?: number
  color?: string
  box?: string
}

/**
 * Desenha o bloco com o topo-centro em (0,0) do contexto atual.
 * fx(i) permite destacar/animar cada palavra.
 */
export function drawTextLayout(ctx: Ctx2D, L: TextLayout, s: TextStyle, fx?: (i: number) => WordFx | null, sizeScale = 1): void {
  setFont(ctx, s, L.size)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const padX = s.box.padX * sizeScale
  const padY = s.box.padY * sizeScale
  const radius = s.box.radius * sizeScale
  const fxs = L.words.map((w) => (fx ? fx(w.index) : null))

  // caixas de fundo
  if (s.box.mode === 'block' && L.words.length) {
    ctx.fillStyle = s.box.color
    const x0 = Math.min(...L.lines.map((l) => l.x0))
    const x1 = Math.max(...L.lines.map((l) => l.x1))
    ctx.beginPath()
    ctx.roundRect(x0 - padX, -padY, x1 - x0 + padX * 2, L.height + padY * 2, radius)
    ctx.fill()
  } else if (s.box.mode === 'line') {
    ctx.fillStyle = s.box.color
    for (const l of L.lines) {
      if (l.x1 <= l.x0) continue
      ctx.beginPath()
      ctx.roundRect(l.x0 - padX, l.y - L.lineHeight / 2 - padY / 2, l.x1 - l.x0 + padX * 2, L.lineHeight + padY, radius)
      ctx.fill()
    }
  }

  const strokeW = s.stroke.width * sizeScale
  const hasShadow = s.shadow.blur > 0 || s.shadow.x !== 0 || s.shadow.y !== 0
  const passes: ('box' | 'stroke' | 'fill')[] = ['box']
  if (strokeW > 0) passes.push('stroke')
  passes.push('fill')

  for (const pass of passes) {
    L.words.forEach((w, k) => {
      if (w.text === '\n') return
      const f = fxs[k]
      const alpha = f?.alpha ?? 1
      if (alpha <= 0.001) return
      const sc = f?.scale ?? 1
      const cx = w.x + w.w / 2
      ctx.save()
      ctx.globalAlpha *= alpha
      ctx.translate(cx, w.y + (f?.dy ?? 0))
      if (sc !== 1) ctx.scale(sc, sc)
      if (pass === 'box') {
        const boxColor = f?.box ?? (s.box.mode === 'word' && !fx ? s.box.color : undefined)
        if (boxColor) {
          ctx.fillStyle = boxColor
          ctx.beginPath()
          ctx.roundRect(-w.w / 2 - padX, -L.lineHeight / 2 - padY / 2 + L.size * 0.04, w.w + padX * 2, L.lineHeight + padY, radius)
          ctx.fill()
        }
      } else if (pass === 'stroke') {
        if (hasShadow) applyShadow(ctx, s, sizeScale)
        ctx.lineJoin = 'round'
        ctx.miterLimit = 2
        ctx.lineWidth = strokeW * 2
        ctx.strokeStyle = s.stroke.color
        ctx.strokeText(w.text, -w.w / 2, 0)
      } else {
        if (hasShadow && strokeW <= 0) applyShadow(ctx, s, sizeScale)
        ctx.fillStyle = f?.color ?? s.fill
        ctx.fillText(w.text, -w.w / 2, 0)
      }
      ctx.restore()
    })
  }
}

function applyShadow(ctx: Ctx2D, s: TextStyle, k: number): void {
  ctx.shadowColor = s.shadow.color
  ctx.shadowBlur = s.shadow.blur * k
  ctx.shadowOffsetX = s.shadow.x * k
  ctx.shadowOffsetY = s.shadow.y * k
}
