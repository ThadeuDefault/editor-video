import { describe, expect, it } from 'vitest'
import { applyGlossary, groupWords, retimeWords, timelineWords, toSrt, blocksToItems } from './captions'
import { builtinTemplates, newProject } from '../state/defaults'
import type { Word } from '../state/types'

const tpl = builtinTemplates()[0]
const mk = (text: string, step = 0.3, gapAt: number[] = []): Word[] => {
  let t = 0
  return text.split(' ').map((w, i) => {
    if (gapAt.includes(i)) t += 1
    const s = t
    t += step
    return { text: w, start: s, end: s + step * 0.9 }
  })
}

describe('groupWords', () => {
  it('respeita 3 a 6 palavras por bloco', () => {
    const blocks = groupWords(mk('um dois três quatro cinco seis sete oito nove dez onze doze treze'), tpl)
    for (const b of blocks) expect(b.words.length).toBeLessThanOrEqual(6)
    expect(blocks.flatMap((b) => b.words).length).toBe(13)
  })
  it('não termina bloco com artigo ou preposição', () => {
    const blocks = groupWords(mk('eu fui ontem até a casa da minha mãe com o carro novo dela'), tpl)
    const bad = new Set(['a', 'o', 'da', 'com', 'minha', 'até'])
    for (const b of blocks.slice(0, -1)) expect(bad.has(b.words[b.words.length - 1].text)).toBe(false)
  })
  it('quebra após pontuação e remove ponto final', () => {
    const blocks = groupWords(mk('olá pessoal tudo bem. hoje vamos aprender algo novo.'), tpl)
    expect(blocks[0].words.map((w) => w.text).join(' ')).toBe('olá pessoal tudo bem')
    expect(blocks[blocks.length - 1].words.at(-1)!.text).toBe('novo')
  })
  it('mantém interrogação', () => {
    const blocks = groupWords(mk('você sabe fazer isso?'), tpl)
    expect(blocks[0].words.at(-1)!.text).toBe('isso?')
  })
  it('quebra em pausas longas', () => {
    const blocks = groupWords(mk('primeira frase aqui segunda frase aqui', 0.3, [3]), tpl)
    expect(blocks[0].words.map((w) => w.text)).toEqual(['primeira', 'frase', 'aqui'])
  })
  it('duração mínima de 0,6 s', () => {
    const blocks = groupWords(mk('a b c. d e f.', 0.1, [3]), tpl)
    for (const b of blocks) expect(b.end - b.start).toBeGreaterThanOrEqual(0.6 - 1e-9)
  })
  it('não deixa palavra solta num bloco', () => {
    // "o" isolado por pausa curta antes e longa depois: vai para o bloco anterior
    const blocks = groupWords(mk('falei com ele o', 0.3).concat([{ text: 'depois', start: 3, end: 3.3 }, { text: 'voltamos', start: 3.3, end: 3.6 }, { text: 'logo', start: 3.6, end: 3.9 }]), tpl)
    for (const b of blocks) expect(b.words.length).toBeGreaterThan(1)
  })
  it('escolhe ponto de corte natural no bloco cheio', () => {
    const blocks = groupWords(mk('vamos lá que eu vou te ensinar agora mesmo'), tpl)
    expect(blocks[0].words.map((w) => w.text).join(' ')).toBe('vamos lá que eu vou')
  })
  it('preposição não fica no fim mesmo com pausa', () => {
    const words = mk('organizei as finanças da').concat([{ text: 'minha', start: 2.2, end: 2.5 }, { text: 'empresa', start: 2.5, end: 2.9 }])
    const blocks = groupWords(words, tpl)
    expect(blocks[0].words.at(-1)!.text).toBe('finanças')
  })
  it('remove reticências', () => {
    const blocks = groupWords(mk('calma aí... pessoal tudo bem'), tpl)
    expect(blocks.flatMap((b) => b.words.map((w) => w.text))).toContain('aí')
  })
  it('respeita a função de largura', () => {
    const blocks = groupWords(mk('um dois três quatro cinco seis'), tpl, (t) => t.length <= 4)
    expect(blocks[0].words.length).toBe(4)
  })
})

describe('applyGlossary', () => {
  it('troca palavra mantendo pontuação', () => {
    const w = applyGlossary(mk('usando o Cloud, que é bom'), [{ from: 'cloud', to: 'Claude' }])
    expect(w.map((x) => x.text).join(' ')).toBe('usando o Claude, que é bom')
  })
  it('troca expressão de várias palavras', () => {
    const w = applyGlossary(mk('o cloud code é top'), [{ from: 'cloud code', to: 'Claude Code' }])
    expect(w.map((x) => x.text)).toEqual(['o', 'Claude Code', 'é', 'top'])
  })
})

describe('timelineWords', () => {
  it('mapeia palavras pelos cortes', () => {
    const p = newProject()
    p.assets.push({
      id: 'a', name: 'v', originalPath: '', proxyPath: '', kind: 'video', duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true,
      transcript: { model: 'm', words: [{ text: 'um', start: 1, end: 1.4 }, { text: 'dois', start: 5, end: 5.4 }, { text: 'três', start: 8, end: 8.4 }] }
    })
    const base = { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, keyframes: {}, assetId: 'a', volume: 1, muted: false, fadeIn: 0, fadeOut: 0, type: 'video' as const }
    p.tracks[0].items = [
      { ...base, id: 'i1', start: 0, duration: 2, inPoint: 0.5 },
      { ...base, id: 'i2', start: 2, duration: 2, inPoint: 7.5 }
    ]
    const w = timelineWords(p)
    expect(w.map((x) => x.text)).toEqual(['um', 'três'])
    expect(w[0].start).toBeCloseTo(0.5)
    expect(w[1].start).toBeCloseTo(2.5)
  })
})

describe('SRT', () => {
  it('gera tempos e maiúsculas', () => {
    const items = blocksToItems([{ start: 1.5, end: 3.25, words: [{ text: 'olá', start: 1.5, end: 2 }, { text: 'ação', start: 2, end: 3 }] }], 't', 1080, 1920)
    const srt = toSrt(items, () => true)
    expect(srt).toContain('00:00:01,500 --> 00:00:03,250')
    expect(srt).toContain('OLÁ AÇÃO')
  })
  it('retimeWords redistribui quando muda a contagem', () => {
    const [item] = blocksToItems([{ start: 0, end: 2, words: [{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 1, end: 2 }] }], 't', 1080, 1920)
    const w = retimeWords(item, 'x y z')
    expect(w.length).toBe(3)
    expect(w[2].end).toBeCloseTo(2)
  })
})
