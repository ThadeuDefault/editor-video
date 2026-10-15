import { app, BrowserWindow, ipcMain, Menu, session } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { dataDir, sub } from './paths'
import { handleMediaProtocol, registerMediaScheme } from './protocol'
import { cleanupTemp } from './whisper'

// Mantém tudo (inclusive o cache do Chromium) na pasta portátil
app.setPath('userData', sub('chromium'))
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')
// sem isso o Chromium pausa o preview quando outra janela cobre o editor
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
registerMediaScheme()

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1115',
    title: 'EditorVideo',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => {
    win?.maximize()
    win?.show()
  })
  // fechar com projeto não salvo: o renderer decide
  win.on('close', (e) => {
    if ((win as any).__allowClose) return
    e.preventDefault()
    win?.webContents.send('menu', 'request-close')
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  dataDir()
  handleMediaProtocol()
  Menu.setApplicationMenu(null)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)
  registerIpc(() => win)
  ipcMain.handle('confirmClose', () => {
    if (win) {
      ;(win as any).__allowClose = true
      win.close()
    }
  })
  ipcMain.handle('toggleDevTools', () => win?.webContents.toggleDevTools())
  createWindow()
  setTimeout(cleanupTemp, 5000)
})

app.on('window-all-closed', () => app.quit())
