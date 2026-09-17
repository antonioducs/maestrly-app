import { DESKTOP_LIVE_CAPABILITY, ROUTINE_HOST_CAPABILITY, CHAT_HOST_CAPABILITY, TEAM_HOST_CAPABILITY, VOICE_HOST_CAPABILITY, modelSelectionSchema } from '@maestrly/host-protocol'
import { GlobalAccounts } from './global-accounts'
import { accountEndpointFor } from './account-endpoint'
import { HostConnections } from './host-connections'
import { registerIpc } from './ipc'
import { validateResult, type Host } from './host-client'
import { app, BrowserWindow, dialog, net, shell, systemPreferences, webContents, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { DesktopViewServer, VIEW_HEADER } from './desktop-view-server'
import { DesktopClient, type DesktopRpc } from './desktop-client'
import { openMedia } from './desktop-transport'
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
import { TeamClient } from './team-client'
import { RoutineClient } from './routine-client'
import { VoiceClient } from './voice-client'
import { PromptClient } from './prompt-client'
import { ExtensionClient, skillNameFrom } from './extension-client'
import { UsageClient } from './usage-client'
import { readSkillFolder } from './skill-folder'
import { ModelMetaCatalogue } from './model-meta'
import { installMicrophonePermissions, requestSystemMicrophone } from './microphone-permissions'
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
      noTeams: process.env.MAESTRLY_BOT_FIXTURE_NO_TEAMS === '1',
      noRoutines: process.env.MAESTRLY_BOT_FIXTURE_NO_ROUTINES === '1',
      noVoice: process.env.MAESTRLY_BOT_FIXTURE_NO_VOICE === '1',
      noChat: process.env.MAESTRLY_BOT_FIXTURE_NO_CHAT === '1',
      suggestRoutine: process.env.MAESTRLY_BOT_FIXTURE_ROUTINE_PROPOSAL === '1',
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
    // Armed only while a person is actually holding the record button in this window.
    const microphone = { armed: false }
    const rendererFile = join(import.meta.dirname, '../renderer/index.html')
    const expectedUrl = new URL(
      (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) || pathToFileURL(rendererFile).href
    ).href
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== expectedUrl) event.preventDefault()
    })
    // Both handlers, one decision: a request prompt and the synchronous check the page makes
    // before it asks. Installing only the first would leave the second at its default, which is
    // how a renderer ends up believing it holds a device it was never granted.
    installMicrophonePermissions({ session: win.webContents.session, contents: win.webContents, expectedUrl, gate: microphone })
    // Loopback-only socket feeding noVNC. Tickets travel in the subprotocol, and only this
    // window's own WebSocket requests carry the binding header.
    const rendererOrigins = () => {
      const url = new URL(expectedUrl)
      return url.protocol === 'file:' ? ['file://', 'null'] : [url.origin]
    }
    const viewServer = new DesktopViewServer({
      origins: rendererOrigins,
      alive: (id) => {
        const contents = webContents.fromId(id)
        return !!contents && !contents.isDestroyed() && id === win.webContents.id
      },
    })
    await viewServer.start()
    win.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`ws://127.0.0.1:${viewServer.port}/*`] }, (details, callback) => {
      const headers = { ...details.requestHeaders }
      for (const name of Object.keys(headers)) if (name.toLowerCase() === VIEW_HEADER) delete headers[name]
      if (details.webContentsId === win.webContents.id) headers[VIEW_HEADER] = viewServer.binding(win.webContents.id)
      callback({ requestHeaders: headers })
    })
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
    const journal = new BotJournal(join(profile.userData, fixture ? `bot-journal-fixture-${process.pid}.json` : 'bot-journal.json'))
    const bots = new BotClient(journal, request)
    // Teams share the journal file but keep their own namespace, lookups and receipts.
    const teams = new TeamClient(journal, request)
    const routines = new RoutineClient(journal, request)
    const voice = new VoiceClient(journal, request)
    const prompts = new PromptClient(request)
    const extensions = new ExtensionClient(request)
    const usage = new UsageClient(request)
    // Context windows and prices for the meter: the fixture never touches the network.
    const modelMeta = fixture
      ? { current: async () => ({ 'openai/fixture-small': { contextWindow: 200_000, inputPer1M: 1.25, outputPer1M: 10 }, 'openai/fixture-large': { contextWindow: 400_000, inputPer1M: 5, outputPer1M: 20 } }) }
      : new ModelMetaCatalogue(profile.userData, async (url, signal) => {
          const response = await net.fetch(url, { signal })
          if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`)
          return response.json()
        })
    const desktop = new DesktopClient({
      target: () => (fixture ? (fixture.connected ? { kind: 'local' as const, id: 'local' as const, displayName: 'Este Mac (fixture)', hostId: 'd9a02e5b-0c12-4411-9393-b5106ecff181' } : undefined) : active),
      // A dedicated control connection: screen input never waits behind chat requests.
      connect: async (target): Promise<DesktopRpc> => {
        if (fixture) return { request: (method, params) => fixture.request(method, params).then((result) => validateResult(method, result)), disconnect: () => {} }
        const transport = target.kind === 'local' ? new LocalTransport() : new SshTransport()
        if (target.kind === 'local') await (transport as LocalTransport).connectLocal()
        else transport.connect(target.alias)
        try {
          const host = (await transport.request('host.inspect', {})) as Host
          if (!target.hostId || host.id !== target.hostId) throw new Error('A identidade deste computador mudou. Confirme o destino antes de abrir a tela.')
          if (!host.capabilities.includes(DESKTOP_LIVE_CAPABILITY)) throw Object.assign(new Error('Atualize o Host para ver a tela'), { code: 'DESKTOP_UPDATE_REQUIRED' })
          return transport
        } catch (error) {
          transport.disconnect()
          throw error
        }
      },
      openMedia: (target, ticket) => (fixture ? fixture.desktopMedia(ticket) : openMedia(target, ticket)),
      server: viewServer,
      emit: (id, event) => {
        const contents = webContents.fromId(id)
        if (contents && !contents.isDestroyed()) contents.send('bot:desktop-event', event)
      },
      clientInstanceId: randomUUID(),
    })
    app.on('before-quit', () => {
      desktop.reset('CLOSED')
      void viewServer.close()
    })
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
        teamSupport: !base.connected ? 'unknown' : hostCapabilities.includes(TEAM_HOST_CAPABILITY) ? 'available' : 'host-outdated',
        routineSupport: !base.connected ? 'unknown' : hostCapabilities.includes(ROUTINE_HOST_CAPABILITY) ? 'available' : 'host-outdated',
        voiceSupport: !base.connected ? 'unknown' : hostCapabilities.includes(VOICE_HOST_CAPABILITY) ? 'available' : 'host-outdated',
        chatSupport: !base.connected ? 'unknown' : hostCapabilities.includes(CHAT_HOST_CAPABILITY) ? 'available' : 'host-outdated',
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
    const botIdOf = (value: unknown) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('Invalid bot')
      return value
    }
    const handleOf = (value: unknown) => {
      if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid desktop view')
      return value
    }
    const handlers: Record<string, (arg: unknown, event: IpcMainInvokeEvent) => unknown> = {
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
        desktop.reset('DISCONNECTED')
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
        if (active?.id !== target.id) desktop.reset('TARGET_CHANGED')
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
          teams.connected(host.id)
          routines.connected(host.id)
          voice.connected(host.id)
          prompts.connected(host.id)
          extensions.connected(host.id)
          usage.connected(host.id)
          if (hostCapabilities.includes('bot.runtime.v1')) await bots.recover()
          // Only a Host that knows teams can answer team lookups; an older one is left alone.
          if (hostCapabilities.includes(TEAM_HOST_CAPABILITY)) await teams.recover()
          // Only a Host that knows these domains can answer their lookups; an older one is left alone.
          if (hostCapabilities.includes(ROUTINE_HOST_CAPABILITY)) await routines.recover()
          if (hostCapabilities.includes(VOICE_HOST_CAPABILITY)) await voice.recover()
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
      team: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(TEAM_HOST_CAPABILITY))
          throw new Error('Atualize este computador para usar equipes de bots')
        const result = await teams.call(value)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return result
      },
      routine: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(ROUTINE_HOST_CAPABILITY)) throw new Error('Atualize este computador para usar rotinas')
        const result = await routines.call(value)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return result
      },
      prompt: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(CHAT_HOST_CAPABILITY)) throw new Error('Atualize este computador para usar comandos')
        const result = await prompts.call(value)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return result
      },
      extension: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(CHAT_HOST_CAPABILITY)) throw new Error('Atualize este computador para configurar MCP e skills')
        const result = await extensions.call(value)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return result
      },
      usage: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(CHAT_HOST_CAPABILITY)) throw new Error('Atualize este computador para ver uso e custos')
        const result = await usage.call(value)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return result
      },
      // A skill is read here, in the main process, from a folder the person chose; the renderer
      // never sees a path. The fixture may name the folder so interface tests skip the dialog.
      pickFolder: async () => {
        const preset = fixture ? process.env.MAESTRLY_BOT_FIXTURE_PICK_FOLDER : undefined
        const path = preset ?? (await dialog.showOpenDialog(win, { properties: ['openDirectory'] }).then((result) => (result.canceled ? undefined : result.filePaths[0])))
        if (!path) return null
        return { name: skillNameFrom(basename(path)), files: await readSkillFolder(path) }
      },
      voice: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(VOICE_HOST_CAPABILITY)) throw new Error('Este computador ainda não transcreve mensagens de voz')
        const result = await voice.call(value)
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return result
      },
      voiceUpload: async (value) => {
        const target = active
        if (!target) throw new Error('Conecte-se a um computador antes de continuar')
        if (!hostCapabilities.includes(VOICE_HOST_CAPABILITY)) throw new Error('Este computador ainda não transcreve mensagens de voz')
        const clip = await voice.upload(value)
        // The recording belongs to the Host it was sent to; a target switch mid-upload is an error.
        if (active?.id !== target.id) throw new Error('O computador selecionado mudou. Tente novamente.')
        return clip
      },
      voiceRead: async (value) => voice.read(value),
      modelMeta: async () => modelMeta.current(),
      voiceMicrophone: async () => ({ access: await requestSystemMicrophone(systemPreferences) }),
      voiceArm: async (value) => {
        if (typeof value !== 'boolean') throw new Error('Invalid microphone request')
        microphone.armed = value
        return { armed: microphone.armed }
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
          // A device id is an opaque browser string; null clears it, anything else is ignored.
          microphoneDeviceId:
            typeof patch.microphoneDeviceId === 'string' && patch.microphoneDeviceId.length <= 128
              ? patch.microphoneDeviceId
              : (patch.microphoneDeviceId as unknown) === null
                ? undefined
                : current.microphoneDeviceId,
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
      // Inspection has no secrets and uses the main connection; opening a screen uses the
      // dedicated desktop connection. Handles are bound to the invoking renderer.
      desktopInspect: async (value) => {
        if (!fixture && !hostCapabilities.includes(DESKTOP_LIVE_CAPABILITY)) throw Object.assign(new Error('Atualize o Host para ver a tela'), { code: 'DESKTOP_UPDATE_REQUIRED' })
        return request('bot.desktop.inspect', { botId: botIdOf(value) })
      },
      desktopOpen: async (value, event) => desktop.open(event.sender.id, botIdOf(value)),
      desktopClose: async (value, event) => desktop.close(event.sender.id, handleOf(value)),
      desktopAcquire: async (value, event) => desktop.acquire(event.sender.id, handleOf(value)),
      desktopInput: async (value, event) => {
        const input = value as { handle?: unknown; events?: unknown }
        if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['handle', 'events'].includes(key))) throw new Error('Invalid desktop input')
        return desktop.input(event.sender.id, handleOf(input.handle), input.events)
      },
      desktopReturn: async (value, event) => {
        const input = value as { botId?: unknown; handle?: unknown; continueTask?: unknown }
        if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['botId', 'handle', 'continueTask'].includes(key)) || typeof input.continueTask !== 'boolean')
          throw new Error('Invalid desktop return')
        return desktop.returnControl(event.sender.id, { botId: botIdOf(input.botId), ...(input.handle !== undefined ? { handle: handleOf(input.handle) } : {}) }, input.continueTask)
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
    // A reload, crash or close ends the renderer's views; a controller becomes a pause.
    const revokeViews = () => desktop.revoke(win.webContents.id)
    win.webContents.on('did-start-loading', revokeViews)
    win.webContents.on('render-process-gone', revokeViews)
    win.on('closed', () => desktop.reset('CLOSED'))
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
