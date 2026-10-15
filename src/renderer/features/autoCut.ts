/** Detecção de silêncio a partir do RMS (100 valores por segundo). */

export const WAVE_RATE = 100

export interface SilenceOptions {
  /** dBFS; null = automático */
  thresholdDb: number | null
  /** silêncios menores que isso não são cortados (s) */
  minSilence: number
  /** respiro total mantido entre frases (s) */
  keepGap: number
  /** ruídos curtos menores que isso são ignorados (s) */
  minSpeech: number
}

// minSilence um pouco abaixo de 0,3 s garante que nenhuma pausa > 0,3 s sobreviva (REGRAS-DE-EDICAO, Regra 1)
export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: null, minSilence: 0.25, keepGap: 0.15, minSpeech: 0.08 }

export const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-6))

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -90
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
}

/** Vale do histograma (Otsu) entre ruído de fundo e fala, em dB. */
function otsu(db: number[]): number {
  const hist = new Array(101).fill(0)
  for (const x of db) hist[Math.min(100, Math.max(0, Math.round(-x)))]++
  const total = db.length
  let sumAll = 0
  hist.forEach((c, i) => (sumAll += -i * c))
  let wB = 0
  let sumB = 0
  let best = -50
  let bestVar = -1
  for (let i = 100; i >= 0; i--) {
    wB += hist[i]
    sumB += -i * hist[i]
    if (wB === 0 || wB === total) continue
    const wF = total - wB
    const v = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2
    if (v > bestVar) {
      bestVar = v
      best = -i
    }
  }
  return best
}

/** Limiar automático: vale entre ruído e fala, puxado 20% em direção à fala (descarta respiração/eco). */
export function autoThreshold(db: number[]): number {
  const s = [...db].sort((a, b) => a - b)
  const speech = percentile(s, 0.9)
  const valley = otsu(db)
  const thr = valley + (speech - valley) * 0.2
  return Math.round(Math.max(-65, Math.min(-20, thr)))
}

/**
 * Retorna os trechos a MANTER (tempos de mídia) dentro de [from, to].
 */
export function detectSpeech(rms: Float32Array, from: number, to: number, opts: SilenceOptions): { thresholdDb: number; keep: [number, number][] } {
  const i0 = Math.max(0, Math.floor(from * WAVE_RATE))
  const i1 = Math.min(rms.length, Math.ceil(to * WAVE_RATE))
  const db: number[] = []
  for (let i = i0; i < i1; i++) db.push(toDb(rms[i]))
  const thr = opts.thresholdDb ?? autoThreshold(db)
  if (!db.length) return { thresholdDb: thr, keep: [[from, to]] }

  // runs de fala
  let runs: [number, number][] = []
  let start = -1
  for (let k = 0; k <= db.length; k++) {
    const on = k < db.length && db[k] > thr
    if (on && start < 0) start = k
    if (!on && start >= 0) {
      runs.push([start, k])
      start = -1
    }
  }
  const minSpeech = Math.round(opts.minSpeech * WAVE_RATE)
  runs = runs.filter(([a, b]) => b - a >= minSpeech)
  // junta falas separadas por silêncio curto
  const minSil = opts.minSilence * WAVE_RATE
  const merged: [number, number][] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] < minSil) last[1] = r[1]
    else merged.push([r[0], r[1]])
  }
  const pad = opts.keepGap / 2
  const keep: [number, number][] = []
  for (const [a, b] of merged) {
    const s = Math.max(from, (i0 + a) / WAVE_RATE - pad)
    const e = Math.min(to, (i0 + b) / WAVE_RATE + pad)
    const last = keep[keep.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else if (e - s > 0.04) keep.push([s, e])
  }
  return { thresholdDb: thr, keep }
}

/** Duração total mantida. */
export const keptDuration = (keep: [number, number][]) => keep.reduce((a, [s, e]) => a + (e - s), 0)
