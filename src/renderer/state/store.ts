import { produce, type Draft } from 'immer'
import { create } from 'zustand'
import { newProject } from './defaults'
import type { Id, Project, SafePlatform } from './types'

const MAX_HISTORY = 200

export interface TaskState {
  progress: number
  label: string
}

export interface EditorState {
  project: Project
  filePath: string | null
  dirty: boolean
  past: Project[]
  future: Project[]
  gestureBase: Project | null

  time: number
  playing: boolean
  selection: Id[]
  selectedTrack: Id | null
  /** pixels por segundo na timeline */
  zoom: number
  safe: { show: boolean; platform: SafePlatform; snap: boolean }
  tasks: Record<string, TaskState>
  /** prévia do corte automático: trechos removidos por item */
  cutPreview: { itemId: Id; remove: [number, number][] }[] | null
  panel: 'media' | 'captions' | 'text' | 'templates' | 'audio'
  modal: null | { kind: 'export' } | { kind: 'autocut' } | { kind: 'template'; id: Id } | { kind: 'whisper' } | { kind: 'settings' }
  toast: { text: string; kind: 'info' | 'error' } | null

  commit(fn: (d: Draft<Project>) => void): void
  gestureStart(): void
  gestureUpdate(fn: (d: Draft<Project>) => void): void
  gestureEnd(): void
  /** altera o projeto e todo o histórico, sem criar passo de desfazer (ex.: transcrição de um asset) */
  patchAll(fn: (d: Draft<Project>) => void): void
  undo(): void
  redo(): void
  load(p: Project, path: string | null): void
  set(partial: Partial<EditorState>): void
  setTask(id: string, t: TaskState | null): void
  notify(text: string, kind?: 'info' | 'error'): void
}

export const useEditor = create<EditorState>((set, get) => ({
  project: newProject(),
  filePath: null,
  dirty: false,
  past: [],
  future: [],
  gestureBase: null,
  time: 0,
  playing: false,
  selection: [],
  selectedTrack: null,
  zoom: 80,
  safe: { show: true, platform: 'reels', snap: true },
  tasks: {},
  cutPreview: null,
  panel: 'media',
  modal: null,
  toast: null,

  commit(fn) {
    const { project, past } = get()
    const next = produce(project, fn)
    if (next === project) return
    set({ project: next, past: [...past.slice(-MAX_HISTORY + 1), project], future: [], dirty: true })
  },
  gestureStart() {
    set({ gestureBase: get().project })
  },
  gestureUpdate(fn) {
    const next = produce(get().project, fn)
    if (next !== get().project) set({ project: next })
  },
  gestureEnd() {
    const { gestureBase, project, past } = get()
    if (gestureBase && gestureBase !== project) set({ past: [...past.slice(-MAX_HISTORY + 1), gestureBase], future: [], dirty: true })
    set({ gestureBase: null })
  },
  patchAll(fn) {
    const { project, past, future } = get()
    set({ project: produce(project, fn), past: past.map((p) => produce(p, fn)), future: future.map((p) => produce(p, fn)) })
  },
  undo() {
    const { past, project, future } = get()
    if (!past.length) return
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], dirty: true })
  },
  redo() {
    const { past, project, future } = get()
    if (!future.length) return
    set({ project: future[0], past: [...past, project], future: future.slice(1), dirty: true })
  },
  load(p, path) {
    set({ project: p, filePath: path, past: [], future: [], dirty: false, selection: [], time: 0, playing: false, cutPreview: null })
  },
  set(partial) {
    set(partial)
  },
  setTask(id, t) {
    const tasks = { ...get().tasks }
    if (t) tasks[id] = t
    else delete tasks[id]
    set({ tasks })
  },
  notify(text, kind = 'info') {
    set({ toast: { text, kind } })
    setTimeout(() => {
      if (get().toast?.text === text) set({ toast: null })
    }, kind === 'error' ? 8000 : 3500)
  }
}))

export const ed = () => useEditor.getState()
