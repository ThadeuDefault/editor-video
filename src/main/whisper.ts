import { spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { WHISPER_MODELS, type TranscribeRequest, type WhisperStatus, type Word } from '../shared/api'
import { gpuInfo } from './gpu'
import { mapWords, packSpeech, type PackSeg } from './speechPack'
import { dataDir, modelsDir, tempDir, whisperDir } from './paths'

type Progress = (p: number, label: string) => void

const FALLBACK_RELEASE = 'b5454'
const ASSET_PATTERNS = {
  cpu: [/^whisper-bin-x64\.zip$/],
  cuda: [/^whisper-bin-win-cuda-12[\d.]*-x64\.zip$/, /^whisper-cublas-12[\d.]*-bin-x64\.zip$/]
}

function cliPath(variant: 'cpu' | 'cuda'): string {
  return join(whisperDir(variant), 'whisper-cli.exe')
}

export async function whisperStatus(): Promise<WhisperStatus> {
  const g = await gpuInfo()
  const models = WHISPER_MODELS.filter((m) => existsSync(join(modelsDir(), m.file))).map((m) => m.id)
  return { cpu: existsSync(cliPath('cpu')), cuda: existsSync(cliPath('cuda')), models, hasNvidia: g.hasNvidia }
}

async function download(url: string, dest: string, onProgress: (p: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'EditorVideo' } })
  if (!res.ok || !res.body) throw new Error(`Falha no download (${res.status}): ${url}`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  const tmp = dest + '.part'
  const body = Readable.fromWeb(res.body as never)
  body.on('data', (c: Buffer) => {
    got += c.length
    if (total) onProgress(got / total)
  })
  await pipeline(body, createWriteStream(tmp))
  renameSync(tmp, dest)
}

/** Procura nas versões recentes do whisper.cpp o pacote Windows desejado. */
async function findAssetUrl(variant: 'cpu' | 'cuda'): Promise<string> {
  const pats = ASSET_PATTERNS[variant]
  try {
    const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15', {
      headers: { 'User-Agent': 'EditorVideo', Accept: 'application/vnd.github+json' }
    })
    if (res.ok) {
      const rels = (await res.json()) as { assets: { name: string; browser_download_url: string }[] }[]
      for (const r of rels) for (const p of pats) {
        const a = r.assets.find((x) => p.test(x.name))
        if (a) return a.browser_download_url
      }
    }
  } catch {
    /* usa a versão fixa */
  }
  const name = variant === 'cpu' ? 'whisper-bin-x64.zip' : 'whisper-bin-win-cuda-12.4.0-x64.zip'
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${FALLBACK_RELEASE}/${name}`
}

/** Extrai apenas o whisper-cli.exe e as DLLs (o pacote vem com dezenas de exemplos). */
function extractCli(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err)
      zip.on('error', reject)
      zip.on('end', () => resolve())
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = basename(entry.fileName)
        const want = !entry.fileName.endsWith('/') && (/\.dll$/i.test(name) || /^whisper-cli\.exe$/i.test(name))
        if (!want) return zip.readEntry()
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2)
          const out = createWriteStream(join(destDir, name))
          stream.pipe(out)
          out.on('finish', () => zip.readEntry())
          out.on('error', reject)
        })
      })
      zip.readEntry()
    })
  })
}

export async function whisperInstall(modelId: string, useCuda: boolean, onProgress: Progress): Promise<void> {
  const model = WHISPER_MODELS.find((m) => m.id === modelId) ?? WHISPER_MODELS[0]
  const steps: { variant?: 'cpu' | 'cuda'; weight: number }[] = []
  if (!existsSync(cliPath('cpu'))) steps.push({ variant: 'cpu', weight: 0.05 })
  if (useCuda && !existsSync(cliPath('cuda'))) steps.push({ variant: 'cuda', weight: 0.5 })
  const modelPath = join(modelsDir(), model.file)
  const needModel = !existsSync(modelPath)
  const totalW = steps.reduce((a, s) => a + s.weight, 0) + (needModel ? 0.45 : 0) || 1
  let done = 0
  for (const s of steps) {
    const v = s.variant!
    const label = v === 'cuda' ? 'Baixando motor de transcrição (GPU NVIDIA)' : 'Baixando motor de transcrição'
    const url = await findAssetUrl(v)
    const zip = join(tempDir(), `whisper-${v}.zip`)
    await download(url, zip, (p) => onProgress((done + p * s.weight) / totalW, label))
    onProgress((done + s.weight) / totalW, 'Extraindo')
    await extractCli(zip, whisperDir(v))
    rmSync(zip, { force: true })
    done += s.weight
  }
  if (needModel) {
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`
    await download(url, modelPath, (p) => onProgress((done + p * 0.45) / totalW, `Baixando modelo ${model.label}`))
  }
  onProgress(1, 'Instalado')
}

/** Frases que o whisper inventa em trechos sem fala (música, ruído). */
const HALLUCINATION = /(altyaz|amara\.org|legendas pela comunidade|legendado por|sous-titr|subtitles by|untertitel)/i

/**
 * Junta os tokens do whisper em palavras. O texto dos tokens vem decodificado em latin1
 * porque um caractere UTF-8 (ex.: "ã") pode estar dividido entre dois tokens.
 */
export function tokensToWords(json: { transcription: { tokens: { text: string; offsets: { from: number; to: number } }[] }[] }): Word[] {
  const words: { bytes: string; start: number; end: number }[] = []
  for (const seg of json.transcription) {
    const segText = Buffer.from(seg.tokens.map((t) => t.text).join(''), 'latin1').toString('utf8')
    if (HALLUCINATION.test(segText)) continue
    let cur: { bytes: string; start: number; end: number } | null = null
    for (const t of seg.tokens) {
      const text = t.text
      if (/^\[_[A-Z]+_?\d*\]$/.test(text) || text.startsWith('[_') || text.startsWith('<|')) continue
      const startsWord = text.startsWith(' ') || !cur
      if (startsWord) {
        cur = { bytes: text, start: t.offsets.from / 1000, end: t.offsets.to / 1000 }
        words.push(cur)
      } else if (cur) {
        cur.bytes += text
        cur.end = t.offsets.to / 1000
      }
    }
  }
  const out: Word[] = []
  for (const w of words) {
    const text = Buffer.from(w.bytes, 'latin1').toString('utf8').trim()
    if (!text) continue
    // palavra composta só de pontuação: cola na anterior
    if (/^[.,!?;:…"')\]]+$/.test(text) && out.length) {
      out[out.length - 1].text += text
      continue
    }
    out.push({ text, start: w.start, end: Math.max(w.end, w.start + 0.05) })
  }
  return out
}

export async function transcribe(req: TranscribeRequest, onProgress: Progress): Promise<Word[]> {
  const st = await whisperStatus()
  const model = WHISPER_MODELS.find((m) => m.id === req.model) ?? WHISPER_MODELS.find((m) => st.models.includes(m.id))
  if (!model) throw new Error('Nenhum modelo de transcrição instalado.')
  const modelPath = join(modelsDir(), model.file)
  if (!existsSync(modelPath)) throw new Error('Modelo não instalado.')
  const variants: ('cuda' | 'cpu')[] = []
  if (st.cuda && st.hasNvidia) variants.push('cuda')
  if (st.cpu) variants.push('cpu')
  if (!variants.length) throw new Error('Motor de transcrição não instalado.')
  const outBase = join(tempDir(), `tr-${req.assetId}-${Date.now()}`)
  // áudio só com a fala (tempos mais precisos); cai para o original se não der
  let segs: PackSeg[] | null = null
  let input = req
  if (req.wavePath && existsSync(req.wavePath)) {
    try {
      const packed = outBase + '-fala.wav'
      segs = packSpeech(req.wavPath, req.wavePath, packed)
      if (segs) input = { ...req, wavPath: packed }
    } catch {
      segs = null
    }
  }
  let lastErr: unknown
  for (const v of variants) {
    try {
      await runCli(v, modelPath, input, outBase, onProgress)
      const raw = readFileSync(outBase + '.json').toString('latin1')
      rmSync(outBase + '.json', { force: true })
      if (segs) rmSync(input.wavPath, { force: true })
      const words = tokensToWords(JSON.parse(raw))
      return segs ? mapWords(segs, words) : words
    } catch (e) {
      lastErr = e
      onProgress(0, v === 'cuda' ? 'GPU falhou, tentando pela CPU' : 'Falhou')
    }
  }
  throw lastErr
}

/**
 * O whisper-cli lê os argumentos no codepage ANSI do Windows: caminhos com acento
 * (ex.: "Edição de vídeo") fazem o programa travar. Por isso ele roda com a pasta de dados
 * como diretório atual e recebe só caminhos relativos ASCII.
 */
function asciiRelative(p: string): string {
  const base = dataDir()
  let rel = relative(base, p)
  if (rel.startsWith('..') || /[^\x20-\x7e]/.test(rel)) {
    const copy = join(tempDir(), `entrada-${Date.now()}-${basename(p).replace(/[^\w.-]/g, '_')}`)
    copyFileSync(p, copy)
    rel = relative(base, copy)
  }
  return rel
}

/** Remove acentos do prompt (o argumento não chega como UTF-8). */
const asciiPrompt = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '')

function runCli(variant: 'cpu' | 'cuda', modelPath: string, req: TranscribeRequest, outBase: string, onProgress: Progress): Promise<void> {
  return new Promise((resolve, reject) => {
    const threads = Math.max(2, Math.min(8, cpus().length - 2))
    const args = ['-m', asciiRelative(modelPath), '-f', asciiRelative(req.wavPath), '-l', req.language || 'pt', '-ojf', '-of', relative(dataDir(), outBase), '-np', '-pp', '-t', String(threads), '-sns']
    const prompt = req.prompt ? asciiPrompt(req.prompt) : ''
    if (prompt) args.push('--prompt', prompt)
    const label = variant === 'cuda' ? 'Transcrevendo (GPU)' : 'Transcrevendo (CPU)'
    onProgress(0.01, label)
    const proc = spawn(cliPath(variant), args, { cwd: dataDir(), windowsHide: true })
    let err = ''
    const onData = (d: Buffer) => {
      const s = d.toString()
      err += s
      if (err.length > 20000) err = err.slice(-8000)
      const m = /progress\s*=\s*(\d+)%/g
      let mm: RegExpExecArray | null
      let last = -1
      while ((mm = m.exec(s))) last = parseInt(mm[1], 10)
      if (last >= 0) onProgress(Math.min(0.99, last / 100), label)
    }
    proc.stderr.on('data', onData)
    proc.stdout.on('data', onData)
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0 && existsSync(outBase + '.json')) resolve()
      else reject(new Error(`Transcrição falhou (${variant}, código ${code}): ${err.slice(-1500)}`))
    })
  })
}

export function cleanupTemp(): void {
  try {
    for (const f of readdirSync(tempDir())) {
      const p = join(tempDir(), f)
      if (Date.now() - statSync(p).mtimeMs > 86400_000) rmSync(p, { recursive: true, force: true })
    }
  } catch {
    /* */
  }
}
