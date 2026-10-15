import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { copyFileSync, existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ProgressEvent } from '../shared/api'
import * as exp from './exportService'
import { gpuInfo } from './gpu'
import { clearCache, importMedia } from './importMedia'
import { dataDir, ffmpegPath, fontsDir, tempDir } from './paths'
import { getSetting, setSetting } from './settings'
import { transcribe, whisperInstall, whisperStatus } from './whisper'

export function registerIpc(getWin: () => BrowserWindow | null): void {
  const progress = (e: ProgressEvent) => getWin()?.webContents.send('progress', e)
  const h = (ch: string, fn: (...a: any[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => fn(...a))

  h('appInfo', () => ({ dataDir: dataDir(), version: app.getVersion(), ffmpegPath: ffmpegPath() }))
  h('openDialog', async (o) => {
    const props: ('openFile' | 'openDirectory' | 'multiSelections')[] = [o.directory ? 'openDirectory' : 'openFile']
    if (o.multi) props.push('multiSelections')
    const r = await dialog.showOpenDialog(getWin()!, { title: o.title, filters: o.filters, properties: props })
    return r.canceled ? [] : r.filePaths
  })
  h('saveDialog', async (o) => {
    const r = await dialog.showSaveDialog(getWin()!, { title: o.title, defaultPath: o.defaultPath, filters: o.filters })
    return r.canceled ? null : r.filePath
  })
  h('readText', (p: string) => readFileSync(p, 'utf8'))
  h('writeText', (p: string, c: string) => writeFileSync(p, c, 'utf8'))
  h('readBinary', (p: string) => new Uint8Array(readFileSync(p)))
  h('readRange', (p: string, offset: number, length: number) => {
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(length)
      const n = readSync(fd, buf, 0, length, offset)
      return new Uint8Array(buf.buffer, buf.byteOffset, n)
    } finally {
      closeSync(fd)
    }
  })
  h('fileSize', (p: string) => statSync(p).size)
  h('exists', (p: string) => existsSync(p))
  h('showInFolder', (p: string) => shell.showItemInFolder(p))

  h('importMedia', (p: string) => importMedia(p, (pr, label) => progress({ task: 'import:' + p, progress: pr, label })))
  h('gpuInfo', () => gpuInfo())
  h('clearCache', () => clearCache())
  h('settingsGet', (k: string) => getSetting(k))
  h('settingsSet', (k: string, v: unknown) => setSetting(k, v))

  h('whisperStatus', () => whisperStatus())
  h('whisperInstall', (m: string, cuda: boolean) => whisperInstall(m, cuda, (pr, label) => progress({ task: 'whisper-install', progress: pr, label })))
  h('transcribe', (req) => transcribe(req, (pr, label) => progress({ task: 'transcribe:' + req.assetId, progress: pr, label })))

  h('exportOpenVideo', (p: string) => exp.openVideo(p))
  h('exportWriteVideo', (hd: number, pos: number, d: Uint8Array) => exp.writeVideo(hd, pos, d))
  h('exportCloseVideo', (hd: number) => exp.closeVideo(hd))
  h('exportRawStart', (o) => exp.rawStart(o))
  h('exportRawFrame', (hd: number, d: Uint8Array) => exp.rawFrame(hd, d))
  h('exportRawEnd', (hd: number) => exp.rawEnd(hd))
  h('exportMixAudio', (spec, out: string) => exp.mixAudio(spec, out, (pr) => progress({ task: 'export-audio', progress: pr })))
  h('exportMux', (v: string, a: string, o: string) => exp.mux(v, a, o))
  h('tempPath', (name: string) => join(tempDir(), `${Date.now()}-${name}`))
  h('deleteFile', (p: string) => rmSync(p, { force: true }))

  h('copyFont', (p: string) => {
    const dest = join(fontsDir(), basename(p))
    copyFileSync(p, dest)
    return { family: basename(p, extname(p)), path: dest }
  })
  h('listFonts', () =>
    readdirSync(fontsDir())
      .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
      .map((f) => ({ family: basename(f, extname(f)), path: join(fontsDir(), f) }))
  )
}
