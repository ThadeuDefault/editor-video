import { useEffect, useRef, useState } from 'react'
import { autosave, confirmDiscard, exportSrt, importFiles, mergeTemplates, newProjectAction, openProject, pickAndImport, saveProject, splitAtPlayhead } from './actions'
import { projectDuration } from './engine/compositor'
import { deleteItems, findItem, placeItem } from './state/commands'
import { uid } from './state/defaults'
import { ed, useEditor } from './state/store'
import type { CaptionTemplate, Item, Project } from './state/types'
import { Dialogs } from './ui/Dialogs'
import { Inspector } from './ui/Inspector'
import { LeftPanel } from './ui/LeftPanel'
import { Preview } from './ui/Preview'
import { Timeline } from './ui/Timeline'
import { TopBar } from './ui/TopBar'
import { ProgressBar } from './ui/controls'

let clipboard: { items: Item[]; base: number } | null = null

function keyHandler(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return
  const s = ed()
  if (s.modal) return
  const ctrl = e.ctrlKey || e.metaKey
  const fps = s.project.settings.fps || 30
  const k = e.key.toLowerCase()
  const stop = () => e.preventDefault()
  if (k === ' ') {
    stop()
    s.set({ playing: !s.playing })
  } else if (ctrl && k === 'z' && !e.shiftKey) {
    stop()
    s.undo()
  } else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) {
    stop()
    s.redo()
  } else if (ctrl && k === 's') {
    stop()
    saveProject(e.shiftKey)
  } else if (ctrl && k === 'o') {
    stop()
    openProject()
  } else if (ctrl && k === 'n') {
    stop()
    newProjectAction()
  } else if (ctrl && k === 'i') {
    stop()
    pickAndImport()
  } else if (ctrl && k === 'e') {
    stop()
    s.set({ modal: { kind: 'export' } })
  } else if ((k === 's' && !ctrl) || (ctrl && k === 'b')) {
    stop()
    splitAtPlayhead()
  } else if (k === 'delete' || k === 'backspace') {
    if (!s.selection.length) return
    stop()
    const ids = s.selection
    s.commit((d) => deleteItems(d, ids, e.shiftKey))
    s.set({ selection: [] })
  } else if (k === 'arrowleft' || k === 'arrowright') {
    stop()
    const step = e.shiftKey ? 1 : 1 / fps
    const t = Math.max(0, s.time + (k === 'arrowleft' ? -step : step))
    s.set({ time: Math.round(t * fps) / fps })
  } else if (k === 'home') {
    s.set({ time: 0 })
  } else if (k === 'end') {
    s.set({ time: projectDuration(s.project) })
  } else if (ctrl && k === 'c') {
    const items = s.selection.map((id) => findItem(s.project, id)?.item).filter(Boolean) as Item[]
    if (items.length) clipboard = { items: JSON.parse(JSON.stringify(items)), base: Math.min(...items.map((i) => i.start)) }
  } else if (ctrl && k === 'v') {
    if (!clipboard) return
    stop()
    const cb = clipboard
    const ids: string[] = []
    s.commit((d) => {
      for (const it of cb.items) {
        const copy = { ...JSON.parse(JSON.stringify(it)), id: uid(), start: s.time + (it.start - cb.base) } as Item
        ids.push(copy.id)
        placeItem(d, copy, 0)
      }
    })
    ed().set({ selection: ids })
  } else if (ctrl && k === 'a') {
    stop()
    s.set({ selection: s.project.tracks.flatMap((t) => t.items.map((i) => i.id)) })
  } else if (k === 'escape') {
    s.set({ selection: [], cutPreview: null })
  } else if (k === '+' || k === '=') {
    s.set({ zoom: Math.min(1500, s.zoom * 1.25) })
  } else if (k === '-') {
    s.set({ zoom: Math.max(4, s.zoom / 1.25) })
  } else if (k === 'f12') {
    window.appCtl.toggleDevTools()
  }
}

function Tasks() {
  const tasks = useEditor((s) => s.tasks)
  const entries = Object.entries(tasks)
  if (!entries.length) return null
  return (
    <div className="fixed bottom-4 right-4 z-40 w-[360px] flex flex-col gap-2">
      {entries.map(([id, t]) => (
        <div key={id} className="bg-panel border border-line rounded-lg p-3 shadow-xl">
          <div className="text-[12px] mb-2 truncate">{t.label}</div>
          <ProgressBar value={t.progress} />
        </div>
      ))}
    </div>
  )
}

function Toast() {
  const toast = useEditor((s) => s.toast)
  if (!toast) return null
  return (
    <div
      className={`fixed top-16 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 rounded-lg shadow-xl border max-w-[700px] whitespace-pre-wrap text-[13px] ${
        toast.kind === 'error' ? 'bg-[#3a1620] border-[#7a2538] text-[#ffd0d8]' : 'bg-panel2 border-line'
      }`}
      onClick={() => ed().set({ toast: null })}
    >
      {toast.text}
    </div>
  )
}

export default function App() {
  const [timelineH, setTimelineH] = useState(300)
  const dragging = useRef(false)

  useEffect(() => {
    window.addEventListener('keydown', keyHandler)
    const offP = window.api.onProgress((e) => {
      const s = ed()
      if (e.task.startsWith('export')) return
      const key = e.task === 'whisper-install' ? 'whisper-install' : e.task
      if (s.tasks[key]) s.setTask(key, { progress: e.progress, label: e.label ? `${e.label} — ${Math.round(e.progress * 100)}%` : s.tasks[key]?.label ?? '' })
    })
    const offM = window.api.onMenu(async (a) => {
      if (a === 'request-close' && (await confirmDiscard())) window.appCtl.confirmClose()
    })
    const timer = setInterval(() => autosave().catch(() => {}), 120_000)
    // biblioteca de modelos e glossário salvos
    ;(async () => {
      const lib = await window.api.settingsGet<CaptionTemplate[]>('templates')
      const glossary = await window.api.settingsGet<Project['glossary']>('glossary')
      const s = ed()
      if (!s.dirty && !s.filePath) {
        const p = { ...s.project, templates: lib?.length ? mergeTemplates(s.project.templates, lib) : s.project.templates, glossary: glossary ?? s.project.glossary }
        s.load(p, null)
      }
    })()
    // botão clicado não guarda o foco (senão o Espaço "clica" de novo e anula o play/pause)
    const blurButtons = (e: MouseEvent) => ((e.target as HTMLElement).closest?.('button') as HTMLButtonElement | null)?.blur()
    window.addEventListener('click', blurButtons)
    const prevent = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('keydown', keyHandler)
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      window.removeEventListener('click', blurButtons)
      offP()
      offM()
      clearInterval(timer)
    }
  }, [])

  const onSplitter = (e: React.PointerEvent) => {
    dragging.current = true
    const y0 = e.clientY
    const h0 = timelineH
    const move = (ev: PointerEvent) => setTimelineH(Math.max(160, Math.min(window.innerHeight - 300, h0 - (ev.clientY - y0))))
    const up = () => {
      dragging.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="h-full flex flex-col"
      onDrop={(e) => {
        const files = [...e.dataTransfer.files].map((f) => window.appCtl.pathForFile(f)).filter(Boolean)
        if (files.length && !(e.target as HTMLElement).closest('[data-lane]')) importFiles(files)
      }}
    >
      <TopBar />
      <div className="flex-1 flex min-h-0">
        <LeftPanel />
        <Preview />
        <Inspector />
      </div>
      <div className="h-[5px] cursor-row-resize bg-line hover:bg-accent shrink-0" onPointerDown={onSplitter} />
      <div style={{ height: timelineH }} className="shrink-0">
        <Timeline />
      </div>
      <Dialogs />
      <Tasks />
      <Toast />
    </div>
  )
}

export { exportSrt }
