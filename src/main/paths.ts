import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

let cached: string | null = null

/** Pasta de dados portátil: fica ao lado do .exe (ou em .dados/ durante o desenvolvimento). */
export function dataDir(): string {
  if (cached) return cached
  const base = app.isPackaged
    ? join(process.env.PORTABLE_EXECUTABLE_DIR || dirname(app.getPath('exe')), 'EditorVideo-dados')
    : join(app.getAppPath(), '.dados')
  mkdirSync(base, { recursive: true })
  cached = base
  return base
}

export function sub(...parts: string[]): string {
  const p = join(dataDir(), ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

export const cacheDir = () => sub('cache')
export const whisperDir = (variant: 'cpu' | 'cuda') => sub('whisper', variant)
export const modelsDir = () => sub('modelos')
export const fontsDir = () => sub('fontes')
export const tempDir = () => sub('temp')

function bin(name: string): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'bin', name)]
    : [join(app.getAppPath(), 'resources', 'bin', name)]
  for (const c of candidates) if (existsSync(c)) return c
  return name.replace(/\.exe$/, '') // cai para o ffmpeg do PATH
}

export const ffmpegPath = () => bin('ffmpeg.exe')
export const ffprobePath = () => bin('ffprobe.exe')
