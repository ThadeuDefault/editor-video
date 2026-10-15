import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, ProgressEvent } from '../shared/api'

const inv =
  (ch: string) =>
  (...a: unknown[]) =>
    ipcRenderer.invoke(ch, ...a)

const channels = [
  'appInfo', 'openDialog', 'saveDialog', 'readText', 'writeText', 'readBinary', 'readRange', 'fileSize', 'exists', 'showInFolder',
  'importMedia', 'gpuInfo', 'clearCache', 'settingsGet', 'settingsSet', 'whisperStatus', 'whisperInstall', 'transcribe',
  'exportOpenVideo', 'exportWriteVideo', 'exportCloseVideo', 'exportRawStart', 'exportRawFrame', 'exportRawEnd',
  'exportMixAudio', 'exportMux', 'tempPath', 'deleteFile', 'copyFont', 'listFonts'
] as const

const api: Record<string, unknown> = {}
for (const c of channels) api[c] = inv(c)
api.onProgress = (cb: (e: ProgressEvent) => void) => {
  const fn = (_: unknown, e: ProgressEvent) => cb(e)
  ipcRenderer.on('progress', fn)
  return () => ipcRenderer.removeListener('progress', fn)
}
api.onMenu = (cb: (a: string) => void) => {
  const fn = (_: unknown, a: string) => cb(a)
  ipcRenderer.on('menu', fn)
  return () => ipcRenderer.removeListener('menu', fn)
}

contextBridge.exposeInMainWorld('api', api as unknown as Api)
contextBridge.exposeInMainWorld('appCtl', {
  confirmClose: () => ipcRenderer.invoke('confirmClose'),
  toggleDevTools: () => ipcRenderer.invoke('toggleDevTools'),
  /** caminho real de um File arrastado para a janela */
  pathForFile: (f: File) => webUtils.getPathForFile(f)
})
