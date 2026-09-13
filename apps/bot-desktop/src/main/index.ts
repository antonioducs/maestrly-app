import { HostConnections } from './host-connections'
import { registerIpc } from './ipc'
import { validateResult, type Host } from './host-client'
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { identity } from './identity'
import { aliasValue, validateCall } from './validation'
import { SshTransport } from './ssh-transport'
import { FixtureHost } from './fixture'
const fixtureEnabled = !app.isPackaged && process.env.MAESTRLY_BOT_FIXTURE === '1'
const profile = identity(app.getPath('appData'), app.isPackaged, fixtureEnabled)
// Identity and stores are selected before either lock acquisition or store reads.
app.setName(profile.name)
app.setPath('userData', profile.userData)
app.setPath('sessionData', join(profile.userData, 'session'))
app.setAppUserModelId(profile.id)
const transport = new SshTransport()
const fixture = fixtureEnabled
  ? new FixtureHost({
      lostReply: process.env.MAESTRLY_BOT_FIXTURE_LOST_REPLY,
      retained: process.env.MAESTRLY_BOT_FIXTURE_RETAINED === '1',
    })
  : null
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      title: profile.name,
      width: 1240,
      height: 840,
      minWidth: 840,
      minHeight: 620,
      backgroundColor: '#eef2f5',
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const rendererFile = join(import.meta.dirname, '../renderer/index.html')
    const expectedUrl = new URL(
      (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) || pathToFileURL(rendererFile).href
    ).href
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== expectedUrl) event.preventDefault()
    })
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    const store = join(profile.userData, 'hosts.json')
    const hosts = async (): Promise<string[]> => {
      try {
        const data: unknown = JSON.parse(await readFile(store, 'utf8'))
        return Array.isArray(data) ? data.map(aliasValue) : []
      } catch {
        return []
      }
    }
    const request = (method: string, params: Record<string, unknown>) =>
      fixture
        ? fixture.request(method, params).then((result) => validateResult(method, result))
        : transport.request(method, params)
    const connections = new HostConnections(
      join(profile.userData, fixture ? `pending-fixture-${process.pid}.json` : 'pending-operations.json'),
      request
    )
    const status = () => ({
      ...(fixture ? { connected: fixture.connected, alias: 'local-fixture' } : transport.status()),
      ...connections.status(),
    })
    const handlers: Record<string, (arg: unknown) => unknown> = {
      hosts: () => hosts(),
      status: () => status(),
      disconnect: () => {
        connections.disconnect()
        if (fixture) fixture.connected = false
        else transport.disconnect()
      },
      connect: async (value) => {
        const alias = aliasValue(value)
        if (fixture) fixture.connected = true
        else transport.connect(alias)
        try {
          const host = (await request('host.inspect', {})) as Host
          await connections.connect(alias, host)
        } catch (error) {
          if (fixture) fixture.connected = false
          else transport.disconnect()
          throw error
        }
        const saved = await hosts()
        await mkdir(profile.userData, { recursive: true })
        await writeFile(store, JSON.stringify([...new Set([...saved, alias])]), { mode: 0o600 })
        return status()
      },
      retry: (value) => {
        if (typeof value !== 'string') throw new Error('Invalid idempotency key')
        return connections.retry(value)
      },
      call: async (value) => {
        const call = validateCall(value)
        return connections.call(call)
      },
    }
    registerIpc(win, expectedUrl, handlers)
    if (expectedUrl.startsWith('file:')) await win.loadFile(rendererFile)
    else await win.loadURL(expectedUrl)
    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => transport.disconnect())
}
