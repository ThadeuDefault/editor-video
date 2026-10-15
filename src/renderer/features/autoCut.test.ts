import { describe, expect, it } from 'vitest'
import { DEFAULT_SILENCE, detectSpeech, keptDuration, WAVE_RATE } from './autoCut'

/** fala (0.2) e silêncio (0.001) em trechos de segundos */
function signal(parts: [number, boolean][]): Float32Array {
  const arr: number[] = []
  for (const [dur, speech] of parts) for (let i = 0; i < Math.round(dur * WAVE_RATE); i++) arr.push(speech ? 0.2 : 0.001)
  return new Float32Array(arr)
}

describe('detectSpeech', () => {
  it('remove silêncio longo e mantém respiro de 0,15 s', () => {
    const s = signal([[0.5, false], [2, true], [1, false], [2, true], [0.5, false]])
    const r = detectSpeech(s, 0, s.length / WAVE_RATE, DEFAULT_SILENCE)
    expect(r.keep.length).toBe(2)
    expect(r.keep[0][0]).toBeCloseTo(0.5 - 0.075, 2)
    expect(keptDuration(r.keep)).toBeCloseTo(4 + 0.15 * 2, 1)
  })
  it('não corta pausas curtas (< 0,3 s)', () => {
    const s = signal([[1, true], [0.2, false], [1, true]])
    const r = detectSpeech(s, 0, s.length / WAVE_RATE, DEFAULT_SILENCE)
    expect(r.keep.length).toBe(1)
  })
  it('ignora estalos curtos', () => {
    const s = signal([[1, true], [1, false], [0.03, true], [1, false], [1, true]])
    const r = detectSpeech(s, 0, s.length / WAVE_RATE, DEFAULT_SILENCE)
    expect(r.keep.length).toBe(2)
  })
  it('respeita o intervalo do clipe', () => {
    const s = signal([[2, true], [2, false], [2, true]])
    const r = detectSpeech(s, 3, 6, DEFAULT_SILENCE)
    expect(r.keep[0][0]).toBeGreaterThanOrEqual(3)
    expect(r.keep[r.keep.length - 1][1]).toBeLessThanOrEqual(6)
  })
})
