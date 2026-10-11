import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import { setEmitter } from './bus'
import { registerIpc, startMods } from './ipc'
import { ensureDirs } from './paths'
import { prewarmServices } from './pi'
import { termKill } from './term'
import { loadSettings, log, setLogLevel } from './store'
import { runSmoke } from './smoke'

let window: BrowserWindow | null = null

function createWindow(): void {
  const settings = loadSettings()
  window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 560,
    minHeight: 400,
    title: 'Alpha',
    backgroundColor: settings.theme === 'light' ? '#f7f7f8' : '#111214',
    autoHideMenuBar: true,
    frame: false,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  // show only after the first paint (optimization item 2)
  window.once('ready-to-show', () => window?.show())
  // Ctrl+P opens Alpha's mode menu; block Chromium's print accelerator so the
  // renderer shortcut always wins.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'p') {
      event.preventDefault()
    }
  })
  setTimeout(() => {
    if (window && !window.isVisible()) window.show()
  }, 2500)
}

app.whenReady().then(async () => {
  ensureDirs()
  setLogLevel(loadSettings().logLevel)
  setEmitter((event) => {
    // the window may already be closed/destroyed while a shell or session
    // still streams — sending to destroyed webContents crashes the app
    if (window && !window.isDestroyed()) {
      try {
        window.webContents.send('alpha:event', event)
      } catch {
        // torn down mid-send
      }
      if (event.kind === 'finished' && !window.isFocused() && loadSettings().notifyDone) {
        new Notification({ title: 'Alpha', body: event.summary }).show()
      }
    }
  })
  registerIpc(() => window)
  createWindow()
  await startMods()
  log('info', 'alpha started')

  if (process.env.ALPHA_SMOKE) {
    try {
      await runSmoke()
      app.exit(0)
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
    return
  }

  // background warm-up: services exist before the first chat, but off the
  // startup critical path (optimization item 1)
  setTimeout(() => prewarmServices(), 1500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// The project shell must not outlive the app.
app.on('will-quit', () => termKill())