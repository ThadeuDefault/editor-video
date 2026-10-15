import type { AssetInfo, Rect, SafePlatform, Transform } from '../state/types'
import { baseSize } from '../engine/compositor'

// ---------- Tela dividida ----------

/** Retângulo da metade (em cima/embaixo) para a proporção dada (fração da parte de cima). */
export function splitRect(W: number, H: number, ratio: number, role: 'top' | 'bottom'): Rect {
  const topH = Math.round(H * ratio)
  return role === 'top' ? { x: 0, y: 0, w: W, h: topH } : { x: 0, y: topH, w: W, h: H - topH }
}

/** Transformação para a mídia cobrir (cover) o retângulo, centralizada. */
export function coverTransform(a: Pick<AssetInfo, 'width' | 'height'>, r: Rect, W: number, H: number): Transform {
  const b = baseSize(a, W, H)
  const scale = Math.max(r.w / b.w, r.h / b.h)
  return { x: r.x + r.w / 2, y: r.y + r.h / 2, scale, rotation: 0, opacity: 1 }
}

// ---------- Área segura ----------

export interface SafeSpec {
  label: string
  /** margens em px numa tela 1080x1920 */
  top: number
  bottom: number
  left: number
  right: number
}

export const SAFE_AREAS: Record<SafePlatform, SafeSpec> = {
  reels: { label: 'Instagram Reels', top: 220, bottom: 380, left: 60, right: 140 },
  tiktok: { label: 'TikTok', top: 160, bottom: 480, left: 60, right: 150 },
  shorts: { label: 'YouTube Shorts', top: 200, bottom: 420, left: 60, right: 150 }
}

export function safeRect(platform: SafePlatform, W: number, H: number): Rect {
  if (W > H) {
    // horizontal: área segura de título (5%)
    return { x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 }
  }
  const s = SAFE_AREAS[platform]
  const kx = W / 1080
  const ky = H / 1920
  return { x: s.left * kx, y: s.top * ky, w: W - (s.left + s.right) * kx, h: H - (s.top + s.bottom) * ky }
}

/**
 * Encaixe magnético: aproxima as bordas/centro da caixa das linhas-guia.
 * Retorna o deslocamento a aplicar e as guias ativas.
 */
export function snapBox(
  box: { x0: number; y0: number; x1: number; y1: number },
  guidesX: number[],
  guidesY: number[],
  threshold: number
): { dx: number; dy: number; lines: { x?: number; y?: number }[] } {
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  let best = { dx: 0, d: threshold + 1, g: 0 }
  for (const g of guidesX) for (const v of [box.x0, cx, box.x1]) {
    const d = Math.abs(g - v)
    if (d < best.d) best = { dx: g - v, d, g }
  }
  let bestY = { dy: 0, d: threshold + 1, g: 0 }
  for (const g of guidesY) for (const v of [box.y0, cy, box.y1]) {
    const d = Math.abs(g - v)
    if (d < bestY.d) bestY = { dy: g - v, d, g }
  }
  const lines: { x?: number; y?: number }[] = []
  const dx = best.d <= threshold ? best.dx : 0
  const dy = bestY.d <= threshold ? bestY.dy : 0
  if (best.d <= threshold) lines.push({ x: best.g })
  if (bestY.d <= threshold) lines.push({ y: bestY.g })
  return { dx, dy, lines }
}
