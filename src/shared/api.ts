// Tipos compartilhados entre o processo principal (Node) e a interface (renderer).

export interface Word {
  text: string
  /** segundos, no tempo da mídia de origem */
  start: number
  end: number
}

export type AssetKind = 'video' | 'image' | 'audio'

export interface AssetInfo {
  id: string
  name: string
  originalPath: string
  /** arquivo normalizado usado no preview e no export */
  proxyPath: string
  /** áudio 16 kHz mono (para transcrição); ausente se a mídia não tem áudio */
  wavPath?: string
  /** RMS a cada 10 ms (Float32 little-endian) */
  wavePath?: string
  kind: AssetKind
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  transcript?: { model: string; words: Word[] }
}

export interface GpuInfo {
  hasNvidia: boolean
  gpuName?: string
  /** encoder H.264 do ffmpeg que funcionou no teste */
  ffmpegH264: string
}

export interface WhisperStatus {
  cpu: boolean
  cuda: boolean
  models: string[]
  hasNvidia: boolean
}

export interface WhisperModelDef {
  id: string
  label: string
  file: string
  sizeMb: number
}

export const WHISPER_MODELS: WhisperModelDef[] = [
  { id: 'large-v3-turbo-q5_0', label: 'Preciso (Turbo, ~550 MB)', file: 'ggml-large-v3-turbo-q5_0.bin', sizeMb: 574 },
  { id: 'small-q5_1', label: 'Rápido (Small, ~190 MB)', file: 'ggml-small-q5_1.bin', sizeMb: 190 }
]

export interface TranscribeRequest {
  assetId: string
  wavPath: string
  /** RMS da mídia; usado para remover silêncios antes de transcrever */
  wavePath?: string
  model: string
  language: string
  prompt?: string
}

export interface AudioMixClip {
  path: string
  /** início na mídia (s) */
  inPoint: number
  /** posição na timeline (s) */
  start: number
  duration: number
  /** 1 = 100% */
  volume: number
  fadeIn: number
  fadeOut: number
}

export interface AudioMixSpec {
  clips: AudioMixClip[]
  duration: number
}

export interface ProgressEvent {
  /** identificador da tarefa (ex.: id do asset, 'whisper', 'export') */
  task: string
  /** 0..1 */
  progress: number
  label?: string
}

export interface OpenDialogOptions {
  title?: string
  filters?: { name: string; extensions: string[] }[]
  multi?: boolean
  directory?: boolean
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface AppInfo {
  dataDir: string
  version: string
  ffmpegPath: string
}

export interface Api {
  appInfo(): Promise<AppInfo>
  openDialog(opts: OpenDialogOptions): Promise<string[]>
  saveDialog(opts: SaveDialogOptions): Promise<string | null>
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  readBinary(path: string): Promise<Uint8Array>
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>
  fileSize(path: string): Promise<number>
  exists(path: string): Promise<boolean>
  showInFolder(path: string): Promise<void>

  importMedia(path: string): Promise<AssetInfo>
  gpuInfo(): Promise<GpuInfo>
  clearCache(): Promise<number>

  settingsGet<T = unknown>(key: string): Promise<T | undefined>
  settingsSet(key: string, value: unknown): Promise<void>

  whisperStatus(): Promise<WhisperStatus>
  whisperInstall(modelId: string, useCuda: boolean): Promise<void>
  transcribe(req: TranscribeRequest): Promise<Word[]>

  exportOpenVideo(path: string): Promise<number>
  exportWriteVideo(handle: number, position: number, data: Uint8Array): Promise<void>
  exportCloseVideo(handle: number): Promise<void>
  exportRawStart(opts: { out: string; width: number; height: number; fps: number; bitrate: number }): Promise<number>
  exportRawFrame(handle: number, rgba: Uint8Array): Promise<void>
  exportRawEnd(handle: number): Promise<void>
  exportMixAudio(spec: AudioMixSpec, out: string): Promise<void>
  exportMux(video: string, audio: string, out: string): Promise<void>
  tempPath(name: string): Promise<string>
  deleteFile(path: string): Promise<void>

  copyFont(path: string): Promise<{ family: string; path: string }>
  listFonts(): Promise<{ family: string; path: string }[]>

  onProgress(cb: (e: ProgressEvent) => void): () => void
  onMenu(cb: (action: string) => void): () => void
}

/** Converte caminho local em URL servida pelo protocolo media:// */
export function mediaUrl(path: string): string {
  return 'media://f/' + encodeURIComponent(path)
}
