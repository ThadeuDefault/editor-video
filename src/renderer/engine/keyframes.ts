import type { AnimProp, Easing, Item, Keyframe, Transform } from '../state/types'

function ease(e: Easing, x: number): number {
  switch (e) {
    case 'easeIn':
      return x * x * x
    case 'easeOut':
      return 1 - Math.pow(1 - x, 3)
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
    case 'hold':
      return 0
    default:
      return x
  }
}

/** Valor interpolado de uma lista de keyframes (ordenada) no tempo local t. */
export function interpolate(kfs: Keyframe[], t: number): number {
  if (kfs.length === 0) return NaN
  if (t <= kfs[0].t) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.v
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const x = span <= 0 ? 1 : (t - a.t) / span
      return a.v + (b.v - a.v) * ease(a.ease, x)
    }
  }
  return last.v
}

/** Transformação efetiva do item no tempo local (s desde o início do item). */
export function transformAt(item: Item, local: number): Transform {
  const tr = { ...item.transform }
  for (const p of Object.keys(item.keyframes) as AnimProp[]) {
    const k = item.keyframes[p]
    if (k && k.length) tr[p] = interpolate(k, local)
  }
  return tr
}

/** Insere/atualiza um keyframe (tolerância de meio frame). */
export function upsertKeyframe(list: Keyframe[] | undefined, t: number, v: number, tol = 1 / 120): Keyframe[] {
  const out = [...(list ?? [])]
  const i = out.findIndex((k) => Math.abs(k.t - t) <= tol)
  if (i >= 0) out[i] = { ...out[i], v }
  else out.push({ t, v, ease: 'easeInOut' })
  out.sort((a, b) => a.t - b.t)
  return out
}

export function keyframeAt(list: Keyframe[] | undefined, t: number, tol = 1 / 120): Keyframe | undefined {
  return list?.find((k) => Math.abs(k.t - t) <= tol)
}
