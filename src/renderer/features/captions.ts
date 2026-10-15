import { uid, defaultTransform } from '../state/defaults'
import type { AudioItem, CaptionItem, CaptionTemplate, GlossaryEntry, Project, VideoItem, Word } from '../state/types'

const CONJ = new Set(['e', 'mas', 'que', 'porque', 'ou', 'então', 'quando', 'pois', 'porém', 'se', 'como', 'enquanto', 'porém', 'embora'])
/** palavras que não podem terminar um bloco (artigo/preposição antes do substantivo) */
const NO_END = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'para', 'pra', 'pro', 'com', 'por', 'pelo', 'pela', 'pelos', 'pelas', 'ao', 'aos', 'à', 'às', 'meu', 'minha', 'meus', 'minhas',
  'seu', 'sua', 'seus', 'suas', 'esse', 'essa', 'este', 'esta', 'nosso', 'nossa', 'num', 'numa', 'sem', 'sobre', 'entre', 'até', 'mais', 'muito', 'muita', 'bem', 'tão',
  // pronomes átonos antes do verbo ("vou te ensinar")
  'te', 'me', 'lhe', 'lhes'
])

const bare = (s: string) => s.toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}]+/gu, '')
const trailingPunct = (s: string) => /[.!?…]$/.test(s)
const softPunct = (s: string) => /[,;:]$/.test(s)

/** Substitui termos (inclusive expressões de várias palavras) mantendo os tempos. */
export function applyGlossary(words: Word[], glossary: GlossaryEntry[]): Word[] {
  const entries = glossary
    .filter((g) => g.from.trim() && g.to.trim())
    .map((g) => ({ from: g.from.trim().split(/\s+/).map(bare), to: g.to.trim() }))
    .sort((a, b) => b.from.length - a.from.length)
  if (!entries.length) return words
  const out: Word[] = []
  let i = 0
  outer: while (i < words.length) {
    for (const e of entries) {
      const n = e.from.length
      if (i + n > words.length) continue
      let ok = true
      for (let k = 0; k < n; k++) if (bare(words[i + k].text) !== e.from[k]) ok = false
      if (!ok) continue
      const last = words[i + n - 1].text
      const lead = /^[^\p{L}\p{N}]*/u.exec(words[i].text)?.[0] ?? ''
      const trail = /[^\p{L}\p{N}]*$/u.exec(last)?.[0] ?? ''
      out.push({ text: lead + e.to + trail, start: words[i].start, end: words[i + n - 1].end })
      i += n
      continue outer
    }
    out.push(words[i])
    i++
  }
  return out
}

/**
 * Itens cuja fala vira legenda: os vídeos com som. Faixas de áudio (música) só entram
 * quando não há nenhum vídeo com som (ex.: podcast só com áudio).
 */
export function speechItems(p: Project): (VideoItem | AudioItem)[] {
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const all: (VideoItem | AudioItem)[] = []
  for (const t of p.tracks) {
    if (t.muted) continue
    for (const it of t.items) if ((it.type === 'video' || it.type === 'audio') && !it.muted && it.volume > 0 && assets.get(it.assetId)?.hasAudio) all.push(it)
  }
  const videos = all.filter((i) => i.type === 'video')
  return videos.length ? videos : all
}

/** Palavras transcritas posicionadas na timeline (respeita cortes, inPoint e mudo). */
export function timelineWords(p: Project, trackIds?: string[]): Word[] {
  const allowed = new Set(speechItems(p).map((i) => i.id))
  const assets = new Map(p.assets.map((a) => [a.id, a]))
  const out: Word[] = []
  for (const track of p.tracks) {
    if (trackIds && !trackIds.includes(track.id)) continue
    if (track.muted) continue
    for (const it of track.items) {
      if ((it.type !== 'video' && it.type !== 'audio') || !allowed.has(it.id)) continue
      const a = assets.get(it.assetId)
      const words = a?.transcript?.words
      if (!words) continue
      const inEnd = it.inPoint + it.duration
      for (const w of words) {
        const mid = (w.start + w.end) / 2
        if (mid < it.inPoint || mid > inEnd) continue
        const s = it.start + Math.max(0, w.start - it.inPoint)
        const e = it.start + Math.min(it.duration, w.end - it.inPoint)
        out.push({ text: w.text, start: s, end: Math.max(e, s + 0.05) })
      }
    }
  }
  out.sort((a, b) => a.start - b.start)
  // remove duplicatas de faixas sobrepostas (mesma fala em dois clipes)
  const dedup: Word[] = []
  for (const w of out) {
    const prev = dedup[dedup.length - 1]
    if (prev && w.start < prev.end - 0.05 && bare(prev.text) === bare(w.text)) continue
    dedup.push(w)
  }
  return dedup
}

export interface Block {
  start: number
  end: number
  words: Word[]
}

/** Agrupa palavras em blocos segundo o modelo (3–6 palavras, quebras naturais, sem artigo solto). */
export function groupWords(words: Word[], tpl: Pick<CaptionTemplate, 'wordsMin' | 'wordsMax' | 'minBlockDur' | 'maxLines'>, fits?: (texts: string[]) => boolean): Block[] {
  const blocks: Word[][] = []
  let cur: Word[] = []
  const flush = () => {
    if (cur.length) blocks.push(cur)
    cur = []
  }
  const endsBad = (w: Word) => NO_END.has(bare(w.text)) && !trailingPunct(w.text) && !softPunct(w.text)
  /** Fecha o bloco; se terminar em artigo/preposição, essa palavra passa para o próximo. */
  const flushSafe = (gap: number) => {
    const last = cur[cur.length - 1]
    if (cur.length > 1 && endsBad(last) && gap < 1.5) {
      cur.pop()
      flush()
      cur.push(last)
    } else flush()
  }
  /** Bloco cheio: escolhe o melhor ponto de corte (pontuação > antes de conjunção > não depois de artigo). */
  const smartSplit = (next: Word) => {
    const n = cur.length
    let best = n
    let bestScore = -Infinity
    for (let c = Math.min(n, Math.max(1, tpl.wordsMin)); c <= n; c++) {
      const last = cur[c - 1]
      const after = c < n ? cur[c] : next
      let score = 0
      if (trailingPunct(last.text)) score += 4
      else if (softPunct(last.text)) score += 3
      if (CONJ.has(bare(after.text))) score += 2
      if (endsBad(last)) score -= 6
      if (score > bestScore || (score === bestScore && c > best)) {
        bestScore = score
        best = c
      }
    }
    blocks.push(cur.slice(0, best))
    cur = cur.slice(best)
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const next = words[i + 1]
    cur.push(w)
    if (!next) break
    const n = cur.length
    const gap = next.start - w.end
    if (gap > 0.6 || (trailingPunct(w.text) && n >= Math.min(2, tpl.wordsMin))) flushSafe(gap)
    else if (n >= tpl.wordsMin && (softPunct(w.text) || CONJ.has(bare(next.text))) && !endsBad(w)) flush()
    else if (n >= tpl.wordsMax || (fits && !fits([...cur, next].map((x) => x.text)))) smartSplit(next)
  }
  flush()

  // palavra solta (1 palavra no bloco): junta com o vizinho mais próximo se couber
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].length !== 1 || blocks.length < 2) continue
    const w = blocks[i][0]
    const prev = blocks[i - 1]
    const next = blocks[i + 1]
    const gp = prev ? w.start - prev[prev.length - 1].end : Infinity
    const gn = next ? next[0].start - w.end : Infinity
    const ok = (b: Word[], merged: Word[]) => b.length < tpl.wordsMax && (!fits || fits(merged.map((x) => x.text)))
    const toPrev = prev && gp < 1 && !trailingPunct(prev[prev.length - 1].text) && ok(prev, [...prev, w])
    // artigo/preposição solto pertence à frase seguinte mesmo com pausa maior
    const toNext = next && (gn < 1 || (NO_END.has(bare(w.text)) && gn < 3)) && !trailingPunct(w.text) && ok(next, [w, ...next])
    if (toPrev && (!toNext || (gp <= gn && !NO_END.has(bare(w.text))))) prev.push(w)
    else if (toNext) next.unshift(w)
    else continue
    blocks.splice(i, 1)
    i--
  }

  const out: Block[] = blocks.map((ws) => ({ start: ws[0].start, end: ws[ws.length - 1].end, words: ws.map((w) => ({ ...w })) }))
  for (let i = 0; i < out.length; i++) {
    const b = out[i]
    const nextStart = out[i + 1]?.start ?? Infinity
    if (b.end - b.start < tpl.minBlockDur) b.end = Math.min(b.start + tpl.minBlockDur, nextStart)
    if (nextStart - b.end < 0.3) b.end = Math.min(nextStart, Math.max(b.end, nextStart))
    if (!isFinite(nextStart)) b.end = Math.max(b.end, b.start + tpl.minBlockDur)
    // sem pontuação final (exceto ? e !)
    const last = b.words[b.words.length - 1]
    last.text = last.text.replace(/[.,;:…]+$/u, '')
    for (const w of b.words) w.text = w.text.replace(/\.{2,}|…/g, '').replace(/^["“”']+|["“”']+$/g, '')
    b.words = b.words.filter((w) => w.text.length)
  }
  return out.filter((b) => b.words.length)
}

export function blocksToItems(blocks: Block[], templateId: string, W: number, H: number): CaptionItem[] {
  return blocks.map((b) => ({
    id: uid(),
    type: 'caption',
    start: b.start,
    duration: Math.max(0.05, b.end - b.start),
    transform: defaultTransform(W, H),
    keyframes: {},
    templateId,
    words: b.words.map((w) => ({ text: w.text, start: Math.max(0, w.start - b.start), end: Math.max(0.01, w.end - b.start) }))
  }))
}

/** Redistribui os tempos quando o usuário edita o texto do bloco. */
export function retimeWords(item: CaptionItem, text: string): CaptionItem['words'] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const old = item.words
  if (tokens.length === old.length) return old.map((w, i) => ({ ...w, text: tokens[i] }))
  // distribui proporcionalmente ao número de letras
  const total = tokens.reduce((a, t) => a + t.length + 1, 0)
  const dur = item.duration
  let acc = 0
  return tokens.map((t) => {
    const s = (acc / total) * dur
    acc += t.length + 1
    return { text: t, start: s, end: (acc / total) * dur }
  })
}

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const r = ms % 1000
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`
}

export function toSrt(items: CaptionItem[], upper: (id: string) => boolean): string {
  return [...items]
    .sort((a, b) => a.start - b.start)
    .map((it, i) => {
      let text = it.words.map((w) => w.text).join(' ')
      if (upper(it.templateId)) text = text.toLocaleUpperCase('pt-BR')
      return `${i + 1}\n${srtTime(it.start)} --> ${srtTime(it.start + it.duration)}\n${text}\n`
    })
    .join('\n')
}
