import { readFileSync, writeFileSync } from 'node:fs'
import { detectSpeech } from '../renderer/features/autoCut'
import type { Word } from '../shared/api'

/**
 * O whisper erra os tempos das palavras que vêm logo depois de um silêncio longo
 * (joga a primeira palavra para o começo do silêncio). Para evitar isso, montamos um
 * WAV só com os trechos de fala (pausas curtas entre eles), transcrevemos esse arquivo e
 * convertemos os tempos de volta para a mídia original.
 */

const RATE = 16000
const GAP = 0.25

export interface PackSeg {
  /** início no arquivo compactado (s) */
  comp: number
  /** início na mídia original (s) */
  orig: number
  len: number
}

function readPcm(wavPath: string): Int16Array {
  const buf = readFileSync(wavPath)
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const start = off + 8
      const n = Math.floor(Math.min(len, buf.length - start) / 2)
      const out = new Int16Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2)
      return out
    }
    off += 8 + len + (len % 2)
  }
  throw new Error('WAV inválido')
}

function writeWav(path: string, pcm: Int16Array): void {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length * 2, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length * 2, 40)
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]))
}

/** Cria o WAV compactado. Retorna null se não houver silêncio relevante para remover. */
export function packSpeech(wavPath: string, wavePath: string, outPath: string): PackSeg[] | null {
  const pcm = readPcm(wavPath)
  const raw = readFileSync(wavePath)
  const rms = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const dur = pcm.length / RATE
  const { keep } = detectSpeech(rms, 0, dur, { thresholdDb: null, minSilence: 0.6, keepGap: 0.5, minSpeech: 0.06 })
  if (!keep.length) return null
  const removed = dur - keep.reduce((a, [s, e]) => a + (e - s), 0)
  if (removed < 1) return null
  const gapSamples = Math.round(GAP * RATE)
  const total = keep.reduce((a, [s, e]) => a + Math.round((e - s) * RATE), 0) + gapSamples * (keep.length - 1)
  const out = new Int16Array(total)
  const segs: PackSeg[] = []
  let w = 0
  keep.forEach(([s, e], i) => {
    if (i) w += gapSamples
    const a = Math.round(s * RATE)
    const b = Math.min(pcm.length, Math.round(e * RATE))
    out.set(pcm.subarray(a, b), w)
    segs.push({ comp: w / RATE, orig: a / RATE, len: (b - a) / RATE })
    w += b - a
  })
  writeWav(outPath, out)
  return segs
}

/** Converte um tempo do arquivo compactado para a mídia original. */
export function mapPacked(segs: PackSeg[], t: number, edge: 'start' | 'end'): number {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (t < s.comp) {
      // caiu na pausa artificial antes deste trecho
      return edge === 'start' ? s.orig : i ? segs[i - 1].orig + segs[i - 1].len : s.orig
    }
    if (t <= s.comp + s.len) return s.orig + (t - s.comp)
  }
  const last = segs[segs.length - 1]
  return last.orig + last.len
}

export function mapWords(segs: PackSeg[], words: Word[]): Word[] {
  return words.map((w) => {
    const start = mapPacked(segs, w.start, 'start')
    let end = mapPacked(segs, w.end, 'end')
    // uma palavra não atravessa um silêncio removido: limita ao fim do trecho dela
    const seg = segs.find((s) => start >= s.orig - 1e-6 && start <= s.orig + s.len + 1e-6)
    if (seg) end = Math.min(end, seg.orig + seg.len)
    return { ...w, start, end: Math.max(start + 0.05, end) }
  })
}
