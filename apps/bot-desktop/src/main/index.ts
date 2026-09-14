import { modelSelectionSchema } from '@maestrly/host-protocol'
import { GlobalAccounts } from './global-accounts'
import { accountEndpointFor } from './account-endpoint'
import { HostConnections } from './host-connections'
import { registerIpc } from './ipc'
import { validateResult, type Host } from './host-client'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { identity } from './identity'
import { aliasValue, validateCall, validateBotCall } from './validation'
import { SshTransport } from './ssh-transport'
import { FixtureHost } from './fixture'
import { HostTargets } from './host-targets'
import { LocalTransport, inspectLocalHost } from './local-transport'
import { BotJournal } from './bot-journal'
import { BotClient } from './bot-client'
import { installLocalHost } from './host-installation'
import type { Connection, HostTarget, OnboardingDraft, UiPreferences } from '../shared/types'
const fixtureEnabled = !app.isPackaged && process.env.MAESTRLY_BOT_FIXTURE === '1'
const profile = identity(app.getPath('appData'), app.isPackaged, fixtureEnabled, fixtureEnabled ? process.env.MAESTRLY_BOT_FIXTURE_SESSION : undefined)
// Identity and stores are selected before either lock acquisition or store reads.
app.setName(profile.name)
app.setPath('userData', profile.userData)
app.setPath('sessionData', join(profile.userData, 'session'))
app.setAppUserModelId(profile.id)
const ssh = new SshTransport()
const local = new LocalTransport()
const fixture = fixtureEnabled
  ? new FixtureHost({
      lostReply: process.env.MAESTRLY_BOT_FIXTURE_LOST_REPLY,
      retained: process.env.MAESTRLY_BOT_FIXTURE_RETAINED === '1',
      slowSetup: process.env.MAESTRLY_BOT_FIXTURE_SLOW_SETUP === '1',
      autoLoginMs: process.env.MAESTRLY_BOT_FIXTURE_AUTOLOGIN_MS ? Number(process.env.MAESTRLY_BOT_FIXTURE_AUTOLOGIN_MS) : undefined,
      noBots: process.env.MAESTRLY_BOT_FIXTURE_NO_BOTS === '1',
      readyEnvironment: process.env.MAESTRLY_BOT_FIXTURE_READY_ENVIRONMENT === '1',
      connectedAccount: process.env.MAESTRLY_BOT_FIXTURE_CONNECTED_ACCOUNT === '1',
    })
  : null
const fixtureNoHost = fixtureEnabled && process.env.MAESTRLY_BOT_FIXTURE_NO_HOST === '1'
const DEFAULT_PREFERENCES: UiPreferences = { theme: 'system', advanced: false, locale: 'pt-BR' }
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      title: profile.name,
      width: 1180,
      height: 800,
      minWidth: 840,
      minHeight: 620,
      backgroundColor: process.platform === 'darwin' ? '#00000000' : '#0A0A0B',
      ...(process.platform === 'darwin' ? {
        vibrancy: 'under-window' as const,
        visualEffectState: 'active' as const,
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 16, y: 14 },
      } : {}),
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
    await mkdir(profile.userData, { recursive: true })
    const targets = new HostTargets(join(profile.userData, 'hosts.json'))
    let active: HostTarget | undefined
    const transportFor = (target: HostTarget) => (target.kind === 'local' ? local : ssh)
    const request = (method: string, params: Record<string, unknown>) => {
      if (fixture) return fixture.request(method, params).then((result) => validateResult(method, result))
      if (!active) return Promise.reject(new Error('Conecte-se a um computador antes de continuar'))
      return transportFor(active).request(method, params)
    }
    const connections = new HostConnections(
      join(profile.userData, fixture ? `pending-fixture-${process.pid}.json` : 'pending-operations.json'),
      request
    )
    const bots = new BotClient(new BotJournal(join(profile.userData, fixture ? `bot-journal-fixture-${process.pid}.json` : 'bot-journal.json')), request)
    const accountTransports = new Map<string, SshTransport>()
    const accountConnections = new Map<string, Promise<SshTransport>>()
    const accountDirectory = new GlobalAccounts(join(profile.userData, fixture ? `accounts-fixture-${process.pid}.json` : 'accounts.json'), {
      targets: async () => fixture ? [{ kind: 'local' as const, id: 'local' as const, displayName: 'Este Mac (fixture)', hostId: 'd9a02e5b-0c12-4411-9393-b5106ecff181' }] : targets.list(),
      endpoint: accountEndpointFor,
      request: async (target, method, params) => {
        if (fixture) return validateResult(method, await fixture.request(method, params))
        if (active?.id === target.id && transportFor(active).status().connected) return request(method, params)
        let transport = accountTransports.get(target.id)
        if (!transport?.status().connected) {
          let pending = accountConnections.get(target.id)
          if (!pending) {
            pending = (async () => {
              const next = target.kind === 'local' ? new LocalTransport() : new SshTransport()
              if (target.kind === 'local') await (next as LocalTransport).connectLocal(); else next.connect(target.alias)
              try {
                const host = await next.request('host.inspect', {}) as Host
                if (!target.hostId || host.id !== target.hostId) throw new Error('A identidade do computador responsável pela conta mudou')
                accountTransports.set(target.id, next)
                return next
              } catch (error) { next.disconnect(); throw error }
            })().finally(() => accountConnections.delete(target.id))
            accountConnections.set(target.id, pending)
          }
          transport = await pending
        }
        return transport.request(method, params)
      },
    })
    app.on('before-quit', () => { for (const transport of accountTransports.values()) transport.disconnect() })
    let hostCapabilities: string[] = []
    const status = (): Connection => {
      const base = fixture ? { connected: fixture.connected, alias: active?.id ?? null } : active ? transportFor(active).status() : { connected: false, alias: null }
      return {
        ...base,
        target: active,
        ...connections.status(),
        accountSupport: !base.connected ? 'unknown' : hostCapabilities.includes('accounts.v1') ? 'available' : 'host-outdated',
        botSupport: !base.connected ? 'unknown' : hostCapabilities.includes('bot.runtime.v1') ? 'available' : 'host-outdated',
      }
    }
    const jsonFile = async <T>(name: string, fallback: T): Promise<T> => {
      try {
        return JSON.parse(await readFile(join(profile.userData, name), 'utf8')) as T
      } catch {
        return fallback
      }
    }
    const saveJson = (name: string, value: unknown) => writeFile(join(profile.userData, name), JSON.stringify(value), { mode: 0o600 })
    const fixtureTargets = (): HostTarget[] => (fixtureNoHost ? [] : [{ kind: 'local', id: 'local', displayName: 'Este Mac (fixture)' }])
    const handlers: Record<string, (arg: unknown) => unknown> = {
      hosts: async () => (fixture ? fixtureTargets() : targets.list()),
      status: () => status(),
      localHost: async () => (fixture ? (fixtureNoHost ? { state: 'missing' } : { state: 'installed', version: 'fixture' }) : inspectLocalHost()),
      installLocalHost: async () => {
        if (fixture) return { status: 'blocked', message: 'Nenhum pacote verificado do Host está preparado neste Mac (fixture).' }
        // The lab namespace/identity/caps come from the administrator-reviewed staged package config; the app never invents them.
        const staged = await jsonFile<{ namespace?: string; identity?: string; caps?: { cpus: number; memoryMiB: number; diskGiB: number }; operator?: string | null } | null>('install-request.json', null)
        if (!staged?.namespace || !staged.identity || !staged.caps)
          return { status: 'blocked', message: 'Falta a autorização de instalação revisada pelo administrador (install-request.json). Escolha outro computador ou peça a instalação administrativa.' }
        return installLocalHost({ namespace: staged.namespace, identity: staged.identity, caps: staged.caps, operator: staged.operator ?? null })
      },
      disconnect: () => {
        connections.disconnect()
        if (fixture) fixture.connected = false
        else if (active) transportFor(active).disconnect()
        hostCapabilities = []
      },
      addSshTarget: async (value) => {
        const alias = aliasValue(value)
        return targets.upsert({ kind: 'ssh', id: `ssh:${alias}`, alias, displayName: alias })
      },
      removeTarget: async (value) => {
        if (typeof value !== 'string') throw new Error('Invalid target')
        if (active?.id === value) throw new Error('Desconecte antes de remover este computador')
        await targets.remove(value)
      },
      connect: async (value) => {
        if (typeof value !== 'string') throw new Error('Invalid target')
        const target = fixture ? fixtureTargets().find((t) => t.id === value) : value === 'local' ? { kind: 'local' as const, id: 'local' as const, displayName: 'Este Mac' } : await targets.get(value)
        if (!target) throw new Error(fixtureNoHost ? 'Nenhum computador configurado' : 'Computador desconhecido')
        // Only a chosen, trusted target is ever contacted; never a scan or a fallback host.
        if (fixture) fixture.connected = true
        else if (target.kind === 'local') await local.connectLocal()
        else ssh.connect(target.alias)
        const previous = active
        active = target
        try {
          const host = (await request('host.inspect', {})) as Host
          if (target.hostId && host.id !== target.hostId)
            throw new Error('A identidade deste computador mudou desde a última conexão. Confirme o destino antes de continuar.')
          hostCapabilities = host.capabilities
          await connections.connect(target.id, host)
          bots.connected(host.id)
          if (hostCapabilities.includes('bot.runtime.v1')) await bots.recover()
          active = { ...target, hostId: host.id, lastConnectedAt: new Date().toISOString() }
          if (!fixture) await targets.upsert(active)
          if (hostCapabilities.includes('accounts.v1')) void accountDirectory.sync(active).catch(() => {})
        } catch (error) {
          if (fixture) fixture.connected = false
          else transportFor(target).disconnect()
          active = previous
          hostCapabilities = []
          throw error
        }
        return status()
      },
      retry: (value) => {
        if (typeof value !== 'string') throw new Error('Invalid idempotency key')
        return connections.retry(value)
      },
      call: async (value) => connections.call(validateCall(value)),
      bot: async (value) => {
        const { call } = validateBotCall(value)
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (call.method.startsWith('account.')) return accountDirectory.call(call, target)
        if ((call.method === 'bot.setup.start' || call.method === 'bot.update') && typeof call.params.accountId === 'string')
          await accountDirectory.ensure(call.params.accountId, target)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return bots.call(call)
      },
      syncAccounts: async () => {
        if (!active) throw new Error('Conecte-se a um computador antes de continuar')
        return accountDirectory.sync(active, true)
      },
      openExternal: async (value) => {
        // Only the official provider login pages may be opened; the URL was validated by the Host as well.
        if (typeof value !== 'string' || !/^https:\/\/(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com)\//.test(value)) return false
        await shell.openExternal(value)
        return true
      },
      draft: () => jsonFile<OnboardingDraft | null>('onboarding-draft.json', null),
      saveDraft: async (value) => {
        if (value === null) return saveJson('onboarding-draft.json', null)
        const draft = value as OnboardingDraft
        if (!draft || typeof draft !== 'object' || typeof draft.name !== 'string' || typeof draft.purpose !== 'string') throw new Error('Invalid draft')
        const clean: OnboardingDraft = { name: draft.name.slice(0, 80), purpose: draft.purpose.slice(0, 4000), updatedAt: new Date().toISOString() }
        for (const key of ['targetId', 'sharedVmId', 'accountId', 'previewId', 'inventoryRevision', 'idempotencyKey', 'operationId', 'botId'] as const)
          if (typeof draft[key] === 'string') clean[key] = draft[key]!.slice(0, 128)
        if (typeof draft.instructions === 'string') clean.instructions = draft.instructions.slice(0, 16000)
        if (Number.isInteger(draft.step) && draft.step! >= 0 && draft.step! <= 2) clean.step = draft.step
        if (draft.model !== undefined) clean.model = modelSelectionSchema.parse(draft.model)
        await saveJson('onboarding-draft.json', clean)
      },
      preferences: async () => ({ ...DEFAULT_PREFERENCES, ...(await jsonFile<Partial<UiPreferences>>('preferences.json', {})) }),
      savePreferences: async (value) => {
        const current = { ...DEFAULT_PREFERENCES, ...(await jsonFile<Partial<UiPreferences>>('preferences.json', {})) }
        const patch = (value ?? {}) as Partial<UiPreferences>
        const next: UiPreferences = {
          theme: ['system', 'light', 'dark'].includes(patch.theme as string) ? (patch.theme as UiPreferences['theme']) : current.theme,
          advanced: typeof patch.advanced === 'boolean' ? patch.advanced : current.advanced,
          locale: patch.locale === 'en' || patch.locale === 'pt-BR' ? patch.locale : current.locale,
          lastBotId: typeof patch.lastBotId === 'string' ? patch.lastBotId.slice(0, 128) : patch.lastBotId === null ? undefined : current.lastBotId,
        }
        await saveJson('preferences.json', next)
        return next
      },
      saveFile: async (value) => {
        // Downloads use the main-process dialog; the guest never chooses a local path.
        const input = value as { name?: unknown; dataBase64?: unknown }
        if (typeof input?.name !== 'string' || typeof input.dataBase64 !== 'string' || input.dataBase64.length > 48 * 1024 * 1024) throw new Error('Invalid file')
        const suggested = basename(input.name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'arquivo'
        const result = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), suggested) })
        if (result.canceled || !result.filePath) return { saved: false }
        await writeFile(result.filePath, Buffer.from(input.dataBase64, 'base64'), { mode: 0o600 })
        return { saved: true }
      },
      pickFile: async () => {
        const result = await dialog.showOpenDialog(win, { properties: ['openFile'] })
        const path = result.filePaths[0]
        if (result.canceled || !path) return null
        const data = await readFile(path)
        if (data.length > 32 * 1024 * 1024) throw new Error('O arquivo excede 32 MiB')
        return { name: basename(path), size: data.length, dataBase64: data.toString('base64') }
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
  app.on('before-quit', () => {
    ssh.disconnect()
    local.disconnect()
    fixture?.bots.dispose()
  })
}
