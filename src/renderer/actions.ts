import { WHISPER_MODELS, type AssetInfo } from '../shared/api'
import { projectDuration, templateOf } from './engine/compositor'
import { captionItemsOf, exportProject } from './engine/exporter'
import { layoutText } from './engine/textLayout'
import { templateScale } from './engine/captionRender'
import { applyGlossary, blocksToItems, groupWords, speechItems, timelineWords, toSrt } from './features/captions'
import { addCaptionTrack, makeMediaItem, makeTextItem, placeItem, splitItem } from './state/commands'
import { builtinTemplates, newProject, newTrack } from './state/defaults'
import { ed } from './state/store'
import type { CaptionTemplate, Project } from './state/types'

const api = () => window.api

export const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', '3gp']
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'avif']
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma']

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export async function pickAndImport(): Promise<void> {
  const files = await api().openDialog({
    title: 'Importar mídia',
    multi: true,
    filters: [
      { name: 'Mídia', extensions: [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT] },
      { name: 'Todos', extensions: ['*'] }
    ]
  })
  if (files.length) await importFiles(files)
}

/** Importa arquivos; opcionalmente já coloca na timeline. */
export async function importFiles(paths: string[], place?: { start: number; trackIndex: number }): Promise<AssetInfo[]> {
  const out: AssetInfo[] = []
  let start = place?.start ?? 0
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop()
    ed().setTask('import:' + path, { progress: 0, label: `Importando ${name}` })
    try {
      const a = await api().importMedia(path)
      out.push(a)
      ed().commit((d) => {
        if (!d.assets.some((x) => x.id === a.id)) d.assets.push(a)
        const isEmpty = d.tracks.every((t) => t.items.length === 0)
        if (a.kind === 'video' && isEmpty && a.fps) d.settings.fps = a.fps
        if (place) {
          const it = makeMediaItem(a, start, d.settings.width, d.settings.height)
          placeItem(d, it, place.trackIndex)
          start += it.duration
        }
      })
    } catch (e) {
      ed().notify(`Falha ao importar ${name}: ${errMsg(e)}`, 'error')
    } finally {
      ed().setTask('import:' + path, null)
    }
  }
  return out
}

/** Adiciona um asset na timeline (no fim da faixa principal, ou no cursor numa faixa nova). */
export function addAssetToTimeline(assetId: string, at?: { start: number; trackIndex: number }): void {
  const s = ed()
  const a = s.project.assets.find((x) => x.id === assetId)
  if (!a) return
  s.commit((d) => {
    const W = d.settings.width
    const H = d.settings.height
    if (at) {
      placeItem(d, makeMediaItem(a, at.start, W, H), at.trackIndex)
      return
    }
    if (a.kind === 'video' || a.kind === 'audio') {
      // vai para o fim da última faixa (faixa base) se ela tiver mídia do mesmo tipo, senão cursor
      const ti = d.tracks.length - 1
      const t = d.tracks[ti]
      const end = t.items.reduce((m, i) => Math.max(m, i.start + i.duration), 0)
      const it = makeMediaItem(a, t.items.length ? end : 0, W, H)
      placeItem(d, it, ti)
    } else {
      placeItem(d, makeMediaItem(a, s.time, W, H), 0)
    }
  })
}

export function addText(): void {
  const s = ed()
  s.commit((d) => {
    const it = makeTextItem(s.time, d.settings.width, d.settings.height)
    placeItem(d, it, 0)
    queueMicrotask(() => ed().set({ selection: [it.id] }))
  })
}

export function splitAtPlayhead(): void {
  const s = ed()
  const t = s.time
  let ids = s.selection
  if (!ids.length) {
    ids = []
    for (const tr of s.project.tracks) if (!tr.locked) for (const i of tr.items) if (t > i.start && t < i.start + i.duration) ids.push(i.id)
  }
  if (!ids.length) return
  const created: string[] = []
  s.commit((d) => {
    for (const id of ids) {
      const n = splitItem(d, id, t)
      if (n) created.push(n)
    }
  })
  if (created.length) ed().set({ selection: created })
}

// ---------------- Projeto ----------------

const PROJECT_FILTER = [{ name: 'Projeto EditorVideo', extensions: ['vproj'] }]

export function serialize(p: Project): string {
  return JSON.stringify({ app: 'EditorVideo', format: 1, project: p })
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = ed()
  let path = s.filePath
  if (!path || saveAs) {
    path = await api().saveDialog({ title: 'Salvar projeto', defaultPath: `${s.project.name}.vproj`, filters: PROJECT_FILTER })
    if (!path) return false
  }
  const name = path.split(/[\\/]/).pop()!.replace(/\.vproj$/i, '')
  s.commit((d) => {
    d.name = name
  })
  await api().writeText(path, serialize(ed().project))
  ed().set({ filePath: path, dirty: false })
  ed().notify('Projeto salvo')
  return true
}

export async function confirmDiscard(): Promise<boolean> {
  if (!ed().dirty) return true
  return window.confirm('Há alterações não salvas. Descartar?')
}

export async function newProjectAction(): Promise<void> {
  if (!(await confirmDiscard())) return
  const p = newProject()
  const lib = await api().settingsGet<CaptionTemplate[]>('templates')
  if (lib?.length) p.templates = mergeTemplates(p.templates, lib)
  const glossary = await api().settingsGet<Project['glossary']>('glossary')
  if (glossary) p.glossary = glossary
  ed().load(p, null)
}

export function mergeTemplates(a: CaptionTemplate[], b: CaptionTemplate[]): CaptionTemplate[] {
  const map = new Map(a.map((t) => [t.id, t]))
  for (const t of b) map.set(t.id, t)
  return [...map.values()]
}

export async function openProject(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return
  if (!path) {
    const r = await api().openDialog({ title: 'Abrir projeto', filters: PROJECT_FILTER })
    if (!r.length) return
    path = r[0]
  }
  try {
    const raw = JSON.parse(await api().readText(path))
    const p = (raw.project ?? raw) as Project
    if (!p.templates?.length) p.templates = builtinTemplates()
    p.glossary ??= []
    p.markers ??= []
    if (!p.tracks.length) p.tracks.push(newTrack('Faixa 1'))
    ed().load(p, path)
    await relinkAssets()
  } catch (e) {
    ed().notify('Não foi possível abrir o projeto: ' + errMsg(e), 'error')
  }
}

/** Se o cache (proxy) sumiu, reimporta o arquivo original. */
async function relinkAssets(): Promise<void> {
  for (const a of ed().project.assets) {
    if (await api().exists(a.proxyPath)) continue
    if (!(await api().exists(a.originalPath))) {
      ed().notify(`Arquivo não encontrado: ${a.originalPath}`, 'error')
      continue
    }
    ed().setTask('import:' + a.originalPath, { progress: 0, label: `Reconvertendo ${a.name}` })
    try {
      const fresh = await api().importMedia(a.originalPath)
      ed().patchAll((d) => {
        const x = d.assets.find((y) => y.id === a.id)
        if (x) Object.assign(x, { ...fresh, id: a.id, transcript: x.transcript })
      })
    } finally {
      ed().setTask('import:' + a.originalPath, null)
    }
  }
}

export async function autosave(): Promise<void> {
  const s = ed()
  if (!s.dirty) return
  const info = await api().appInfo()
  await api().writeText(info.dataDir + '\\autosave.vproj', serialize(s.project))
}

// ---------------- Legendas ----------------

export async function ensureWhisper(): Promise<boolean> {
  const st = await api().whisperStatus()
  if (st.models.length && (st.cpu || st.cuda)) return true
  ed().set({ modal: { kind: 'whisper' } })
  return false
}

/** Transcreve (uma vez) cada mídia com fala usada na timeline. */
export async function transcribeTimeline(model?: string): Promise<void> {
  const st = await api().whisperStatus()
  const modelId = model && st.models.includes(model) ? model : (WHISPER_MODELS.find((m) => st.models.includes(m.id))?.id ?? st.models[0])
  // versão do processo de transcrição (mudou → refaz)
  const tag = `${modelId}@3`
  const p = ed().project
  const used = new Set(speechItems(p).map((i) => i.assetId))
  const prompt = p.glossary.map((g) => g.to).filter(Boolean).join(', ')
  for (const a of p.assets) {
    if (!used.has(a.id) || !a.hasAudio || !a.wavPath) continue
    if (a.transcript && a.transcript.model === tag) continue
    const task = 'transcribe:' + a.id
    ed().setTask(task, { progress: 0, label: `Transcrevendo ${a.name}` })
    try {
      const words = await api().transcribe({ assetId: a.id, wavPath: a.wavPath, wavePath: a.wavePath, model: modelId, language: 'pt', prompt: prompt || undefined })
      ed().patchAll((d) => {
        const x = d.assets.find((y) => y.id === a.id)
        if (x) x.transcript = { model: tag, words }
      })
    } finally {
      ed().setTask(task, null)
    }
  }
}

let measureCtx: OffscreenCanvasRenderingContext2D | null = null

export function captionFits(tpl: CaptionTemplate, W: number, H: number): (texts: string[]) => boolean {
  measureCtx ??= new OffscreenCanvas(10, 10).getContext('2d')!
  const k = templateScale(W, H)
  const maxW = W - 2 * tpl.marginX * k.size
  return (texts) => {
    const tokens = texts.map((t) => (tpl.style.uppercase ? t.toLocaleUpperCase('pt-BR') : t))
    const L = layoutText(measureCtx!, tokens, tpl.style, maxW, 0, k.size)
    return L.lines.length <= tpl.maxLines
  }
}

/** Legenda automática com um clique. */
export async function generateCaptions(templateId?: string, model?: string): Promise<void> {
  if (!(await ensureWhisper())) return
  const s = ed()
  if (!s.project.tracks.some((t) => t.items.some((i) => i.type === 'video' || i.type === 'audio'))) {
    s.notify('Coloque um vídeo ou áudio na timeline primeiro.', 'error')
    return
  }
  try {
    await transcribeTimeline(model)
  } catch (e) {
    ed().notify('Erro na transcrição: ' + errMsg(e), 'error')
    return
  }
  const p = ed().project
  const tpl = templateOf(p, templateId ?? p.templates[0].id)
  await document.fonts.load(`${tpl.style.weight} 40px "${tpl.style.font}"`).catch(() => null)
  const words = applyGlossary(timelineWords(p), p.glossary)
  if (!words.length) {
    ed().notify('Nenhuma fala encontrada.', 'error')
    return
  }
  const blocks = groupWords(words, tpl, captionFits(tpl, p.settings.width, p.settings.height))
  const items = blocksToItems(blocks, tpl.id, p.settings.width, p.settings.height)
  ed().commit((d) => {
    d.tracks = d.tracks.filter((t) => !t.captions)
    addCaptionTrack(d, items, 'Legendas')
    d.tracks[0].captions = true
  })
  ed().notify(`${items.length} legendas criadas`)
}

export async function exportSrt(path?: string): Promise<void> {
  const p = ed().project
  const items = captionItemsOf(p)
  if (!items.length) {
    ed().notify('Não há legendas na timeline.', 'error')
    return
  }
  path ??= (await api().saveDialog({ title: 'Salvar legenda .srt', defaultPath: `${p.name}.srt`, filters: [{ name: 'SubRip', extensions: ['srt'] }] })) ?? undefined
  if (!path) return
  await api().writeText(path, toSrt(items, (id) => templateOf(p, id).style.uppercase))
  ed().notify('Legenda .srt salva')
}

// ---------------- Exportar ----------------

let cancelExport = false
export const requestCancelExport = () => (cancelExport = true)

export async function runExport(o: { out: string; bitrate: number; scale: number; srt: boolean }): Promise<boolean> {
  cancelExport = false
  const s = ed()
  s.set({ playing: false })
  const p = s.project
  if (projectDuration(p) <= 0) {
    s.notify('A timeline está vazia.', 'error')
    return false
  }
  const task = 'export'
  s.setTask(task, { progress: 0, label: 'Preparando' })
  const t0 = performance.now()
  try {
    await exportProject(p, {
      out: o.out,
      bitrate: o.bitrate,
      fps: p.settings.fps,
      scale: o.scale,
      onProgress: (pr, label) => ed().setTask(task, { progress: pr, label }),
      isCancelled: () => cancelExport
    })
    if (o.srt && captionItemsOf(p).length) await exportSrt(o.out.replace(/\.mp4$/i, '').replace(/ - legendado$/i, '') + '.srt')
    const secs = Math.round((performance.now() - t0) / 1000)
    ed().notify(`Exportado em ${secs}s: ${o.out.split(/[\\/]/).pop()}`)
    api().showInFolder(o.out)
    return true
  } catch (e) {
    ed().notify(errMsg(e), 'error')
    return false
  } finally {
    ed().setTask(task, null)
  }
}

export { errMsg }
