import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, protocol: {} }))
import { buildAudioFilter } from './exportService'
import { tokensToWords } from './whisper'

describe('mixagem de áudio', () => {
  it('reaproveita a mesma entrada com asplit', () => {
    const r = buildAudioFilter({
      duration: 10,
      clips: [
        { path: 'a.mp4', inPoint: 0, start: 0, duration: 2, volume: 1, fadeIn: 0, fadeOut: 0 },
        { path: 'a.mp4', inPoint: 5, start: 2, duration: 2, volume: 0.5, fadeIn: 0.2, fadeOut: 0 },
        { path: 'm.mp3', inPoint: 0, start: 0, duration: 10, volume: 0.3, fadeIn: 0, fadeOut: 1 }
      ]
    })
    expect(r.inputs).toEqual(['a.mp4', 'm.mp3'])
    expect(r.filter).toContain('asplit=2')
    expect(r.filter).toContain('adelay=2000:all=1')
    expect(r.filter).toContain('amix=inputs=3')
  })
  it('silêncio quando não há clipes', () => {
    expect(buildAudioFilter({ duration: 3, clips: [] }).filter).toContain('anullsrc')
  })
})

describe('whisper', () => {
  it('junta tokens em palavras com UTF-8 dividido', () => {
    const est = Buffer.from(' estão', 'utf8').toString('latin1')
    const json = {
      transcription: [
        {
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ' Alg', offsets: { from: 50, to: 600 } },
            { text: 'umas', offsets: { from: 600, to: 1000 } },
            { text: est.slice(0, 5), offsets: { from: 1100, to: 1200 } },
            { text: est.slice(5), offsets: { from: 1200, to: 1400 } },
            { text: ',', offsets: { from: 1400, to: 1410 } }
          ]
        }
      ]
    }
    const w = tokensToWords(json)
    expect(w.map((x) => x.text)).toEqual(['Algumas', 'estão,'])
    expect(w[0].start).toBeCloseTo(0.05)
    expect(w[0].end).toBeCloseTo(1.0)
  })
})
