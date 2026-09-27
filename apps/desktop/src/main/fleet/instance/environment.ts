import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  FLEET_ENVIRONMENT_LIMITS,
  FLEET_PROTOCOL_VERSION,
  FLEET_SCREEN,
  fleetEnvironmentTile,
  fleetInstanceBotInstallSchema,
  type FleetAccountImportRequest,
  type FleetAddApiKeyAccountRequest,
  type FleetAddApiKeyAccountResponse,
  type FleetBotAccounts,
  type FleetBotMcpServers,
  type FleetBotSkills,
  type FleetImportResults,
  type FleetInstanceBotInstall,
  type FleetInstanceEnvironmentStatus,
  type FleetInstanceProfile,
  type FleetInstanceStatus,
  type FleetLoginAttempt,
  type FleetLoginCallbackRequest,
  type FleetLoginCallbackResponse,
  type FleetLoginStartRequest,
  type FleetMcpImportRequest,
  type FleetSelectionOption,
  type FleetSkillInstallRequest,
  type FleetSkillInstallResponse,
  type FleetSubscriptionKind,
  type FleetUiOpenRequest,
} from '@maestrly/bot-fleet-protocol'
import {
  addProvider,
  addSubscriptionAccount,
  listProviders,
  listSubscriptionAccounts,
  removeProvider,
  renameSubscriptionAccount,
  subscriptionProviderIdFor,
} from '../../chat/catalog'
import { getClaudeSubscriptionManager } from '../../chat/claude-agent-sdk/manager'
import { getCodexSubscriptionManager } from '../../chat/codex-subscription/manager'
import { apiKeyStorageMode, clearApiKey, setApiKey } from '../../chat/credentials'
import { getGrokSubscriptionManager } from '../../chat/grok-subscription/manager'
import { invalidateModels } from '../../chat/models'
import type { PermissionRequest } from '../../chat/permission'
import { invalidateProvider } from '../../chat/provider'
import { getChatPermissionBroker, getChatQuestionBroker } from '../../chat/service'
import { botMemorySpaceId } from '../../memory/spaces'
import { deleteLocalMemorySpace, getAppSetting, setAppSetting } from '../../store'
import { adoptLegacyBot } from './adoption'
import type { EnvironmentInstanceConfig } from './config'
import type { BotDisplay, BotDisplayEnv, DisplayManagerDeps, DisplaySurface, VncLease, VncMode } from './displays'
import {
  SUBSCRIPTION_PROVIDER_KIND,
  cleanupBotSubscriptionSlot,
  importBotAccounts,
  listBotAccounts,
  removeBotSubscription,
} from './provisioning/accounts'
import { forwardLoginCallback } from './provisioning/callback-forwarder'
import { LOGIN_PROVIDER_NAMES, RemoteLogins } from './provisioning/logins'
import { importBotMcpServers, listBotMcpServers, removeBotMcpServer } from './provisioning/mcp'
import { installBotSkill, listBotSkills, removeBotSkill } from './provisioning/skills'
import {
  type InstalledBot,
  botPaths,
  clearGatewayToken,
  deleteBotSettings,
  isBotId,
  readInstalledBots,
  readStoredProfile,
  removeBotFolder,
  writeGatewayToken,
  writeInstalledBots,
} from './registry'
import { BotRuntime, loadFleetAccountOptions, type BotRuntimeHost, type BotScreen } from './runtime'
import { INSTANCE_CAPABILITIES, InstanceEvents, InstanceHttpError } from './server'

/** The part of the display manager an environment uses. */
export interface EnvironmentDisplays {
  startBot(botId: string, slot: number): Promise<BotDisplay>
  stopBot(botId: string): Promise<void>
  acquireVnc(surface: DisplaySurface, mode: VncMode): Promise<VncLease>
  dispose(): Promise<void>
}

export interface EnvironmentRuntimeDeps {
  config: EnvironmentInstanceConfig
  /** Maestrly's data folder. */
  userData: string
  /** The environment's home folder, shared by its bots. */
  home: string
  /** The bots' apps displays, or null outside a container. */
  displays: EnvironmentDisplays | null
  /** Shows a bot's browser in its area of the environment display. */
  floatBrowser(conversationId: string): void
  /** Stops a conversation's turn and closes its windows, terminals and browser views, and nothing else. */
  closeConversation(conversationId: string): Promise<void>
  /** Deletes a conversation with its messages and files. */
  purgeConversation(conversationId: string): Promise<void>
  /** Shows the environment screen (Maestrly's settings), optionally on one of its pages. */
  openSettings(target: FleetUiOpenRequest['target']): void | Promise<void>
}

function log(level: 'info' | 'error', message: string): void {
  console.error(JSON.stringify({ component: 'bot-instance', level, message }))
}
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** The browser wrapper every bot's `BROWSER` names; it opens Chromium with the bot's own profile. */
const BOT_BROWSER = '/usr/local/bin/maestrly-bot-browser'

function gatewayUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

let current: EnvironmentRuntime | null = null
/** The environment runtime of this process, once it has started. */
export function currentEnvironmentRuntime(): EnvironmentRuntime | null {
  return current
}

/**
 * The environment of a bot container: one Maestrly process whose accounts, skills, MCP servers, site logins and home
 * folder are shared by up to eight bots. It owns the registry `botId → BotRuntime`, installs and uninstalls bots, starts
 * their screens, and provisions the environment. Installs and uninstalls run one at a time.
 */
export class EnvironmentRuntime {
  readonly events = new InstanceEvents()
  private readonly registry = new Map<string, BotRuntime>()
  private readonly host: BotRuntimeHost
  private readonly displays: EnvironmentDisplays | null
  private options: FleetSelectionOption[] = []
  private optionsAt = 0
  private optionsSeq = 0
  private optionsApplied = 0
  private optionsLoad: { promise: Promise<FleetSelectionOption[]>; forced: boolean } | null = null
  private lifecycle: Promise<unknown> = Promise.resolve()
  private unwireBrokers: (() => void) | null = null
  private ready = false
  private disposed = false
  private readonly logins = new RemoteLogins({
    now: Date.now,
    onChanged: () => this.accountsChanged(),
    isConnected: (kind, id) =>
      this.options.some(
        (option) => option.providerId === subscriptionProviderIdFor(SUBSCRIPTION_PROVIDER_KIND[kind], id)
      ),
    createSlot: (kind) => {
      const providerKind = SUBSCRIPTION_PROVIDER_KIND[kind]
      const count = listSubscriptionAccounts().filter((slot) => slot.kind === providerKind).length
      return addSubscriptionAccount(providerKind, LOGIN_PROVIDER_NAMES[kind] + ' ' + (count + 2)).id
    },
    renameSlot: (id, label) => {
      renameSubscriptionAccount(id, label)
    },
    removeSlot: cleanupBotSubscriptionSlot,
    slotExists: (kind, id) =>
      listSubscriptionAccounts().some((slot) => slot.id === id && slot.kind === SUBSCRIPTION_PROVIDER_KIND[kind]),
    codex: getCodexSubscriptionManager,
    claude: getClaudeSubscriptionManager,
    grok: getGrokSubscriptionManager,
    forward: forwardLoginCallback,
  })

  constructor(private readonly deps: EnvironmentRuntimeDeps) {
    this.displays = deps.displays
    const url = gatewayUrl(deps.config.gatewayUrl)
    if (deps.config.gatewayUrl && !url) log('error', 'The gateway URL is not an http or https URL; bots stay offline.')
    this.host = {
      userData: deps.userData,
      home: deps.home,
      events: this.events,
      gatewayUrl: url,
      accountOptions: (force) => this.accountOptions(force),
      peers: (botId) =>
        this.bots()
          .filter((bot) => bot.botId !== botId && bot.name)
          .map((bot) => ({ botId: bot.botId, name: bot.name! })),
      floatBrowser: (conversationId) => this.deps.floatBrowser(conversationId),
    }
  }

  /** Adopts a single-bot container from before environments, then recreates every installed bot. */
  async start(): Promise<void> {
    if (current && current !== this) throw new Error('Another environment runtime is running.')
    await adoptLegacyBot({ userData: this.deps.userData })
    current = this
    this.wireBrokers()
    for (const member of readInstalledBots()) {
      try {
        await this.recreate(member)
      } catch (error) {
        log('error', `Could not start bot ${member.botId}: ${errorMessage(error)}`)
      }
    }
    this.ready = true
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unwireBrokers?.()
    this.unwireBrokers = null
    await this.logins.dispose()
    for (const bot of [...this.registry.values()]) await bot.dispose()
    this.registry.clear()
    await this.displays?.dispose().catch((error: unknown) => log('error', errorMessage(error)))
    if (current === this) current = null
  }
  health(): { ok: true; appVersion: string; protocol: 1; ready: boolean; capabilities: string[] } {
    return {
      ok: true,
      appVersion: app.getVersion(),
      protocol: FLEET_PROTOCOL_VERSION,
      ready: this.ready,
      capabilities: [...INSTANCE_CAPABILITIES],
    }
  }

  /** The installed bot, or NOT_FOUND. */
  bot(botId: string): BotRuntime {
    const bot = this.registry.get(botId)
    if (!bot) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    return bot
  }
  /** The installed bots, by slot. */
  bots(): BotRuntime[] {
    return [...this.registry.values()].sort((a, b) => a.slot - b.slot)
  }
  /** The bot whose conversation this is, if any: tools, prompts and hooks of a conversation resolve their bot here. */
  botForConversation(conversationId: string | undefined): BotRuntime | null {
    if (!conversationId) return null
    for (const bot of this.registry.values()) if (bot.primaryConversationId === conversationId) return bot
    return null
  }
  async environmentStatus(): Promise<FleetInstanceEnvironmentStatus> {
    const bots = await Promise.all(
      this.bots().map(async (bot) => ({ botId: bot.botId, slot: bot.slot, status: await bot.status() }))
    )
    return {
      environmentId: this.deps.config.environmentId ?? null,
      capabilities: [...INSTANCE_CAPABILITIES],
      appVersion: app.getVersion(),
      protocol: FLEET_PROTOCOL_VERSION,
      ready: this.ready,
      bots,
    }
  }

  /**
   * Installs a bot, or updates an installed one: its profile, display slot and gateway token. Installing the same
   * values again changes nothing. A slot another bot uses is a CONFLICT.
   */
  async installBot(value: FleetInstanceBotInstall): Promise<FleetInstanceStatus> {
    const parsed = fleetInstanceBotInstallSchema.safeParse(value)
    if (!parsed.success) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid bot installation.')
    const { profile, slot, gatewayToken } = parsed.data
    const bot = await this.serialize(() => this.install(profile, slot, gatewayToken))
    return bot.status()
  }
  /**
   * Uninstalls a bot: it leaves the installed list first, then its turn stops, its conversation's windows close and its
   * screens stop. With `purge`, its conversation, memory space, folders, browser profile and settings are deleted too;
   * the environment's accounts, skills, MCP servers and shared files are never touched.
   */
  async uninstallBot(botId: string, options: { purge: boolean }): Promise<void> {
    if (!isBotId(botId)) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
    await this.serialize(async () => {
      const members = readInstalledBots()
      if (members.some((member) => member.botId === botId))
        writeInstalledBots(members.filter((member) => member.botId !== botId))
      const bot = this.registry.get(botId)
      let conversationId: string | null = null
      if (bot) {
        this.registry.delete(botId)
        conversationId = bot.primaryConversationId
        await bot.cancel().catch((error: unknown) => log('error', errorMessage(error)))
        if (conversationId)
          await this.deps.closeConversation(conversationId).catch((error: unknown) => log('error', errorMessage(error)))
        await bot.dispose({ uninstall: true })
        await this.displays?.stopBot(botId).catch((error: unknown) => log('error', errorMessage(error)))
      }
      clearGatewayToken(botId)
      if (!options.purge) return
      if (!conversationId) {
        try {
          conversationId = readStoredProfile(botId)?.primaryConversationId ?? null
        } catch {
          conversationId = null
        }
      }
      await this.purge(botId, conversationId)
    })
  }

  /**
   * A VNC server for a screen: the environment screen, or the browser area or apps display of an installed bot.
   * The caller releases the lease when its connection ends.
   */
  async acquireScreen(surface: DisplaySurface, mode: VncMode): Promise<VncLease> {
    this.assertOpen()
    if (surface.kind !== 'environment') {
      if (!isBotId(surface.botId)) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
      this.bot(surface.botId)
    }
    if (!this.displays) throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Screen unavailable.')
    return this.displays.acquireVnc(surface, mode)
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(action, action)
    this.lifecycle = run.catch(() => undefined)
    return run
  }
  private assertOpen(): void {
    if (this.disposed) throw new InstanceHttpError(409, 'CONFLICT', 'The environment is shutting down.')
  }
  private async install(profile: FleetInstanceProfile, slot: number, token: string | null): Promise<BotRuntime> {
    this.assertOpen()
    const botId = profile.botId
    const members = readInstalledBots()
    if (
      members.some((member) => member.slot === slot && member.botId !== botId) ||
      this.bots().some((bot) => bot.slot === slot && bot.botId !== botId)
    )
      throw new InstanceHttpError(409, 'CONFLICT', `Display slot ${slot} is used by another bot.`)
    const existing = this.registry.get(botId)
    if (existing) {
      if (token !== null) existing.setGatewayToken(token)
      if (existing.slot !== slot) {
        await this.displays?.stopBot(botId).catch((error: unknown) => log('error', errorMessage(error)))
        existing.slot = slot
        existing.attachScreen(await this.startDisplay(botId, slot))
        writeInstalledBots([...members.filter((member) => member.botId !== botId), { botId, slot }])
      }
      await existing.profile(profile)
      return existing
    }
    if (members.filter((member) => member.botId !== botId).length >= FLEET_ENVIRONMENT_LIMITS.botsMax)
      throw new InstanceHttpError(409, 'CONFLICT', 'This environment already has the most bots it can hold.')
    const wasMember = members.some((member) => member.botId === botId)
    if (token !== null) writeGatewayToken(botId, token)
    const bot = new BotRuntime(botId, slot, this.host)
    try {
      bot.attachScreen(await this.startDisplay(botId, slot))
      await bot.start()
      await bot.profile(profile)
      writeInstalledBots([...members.filter((member) => member.botId !== botId), { botId, slot }])
    } catch (error) {
      await bot.dispose()
      await this.displays?.stopBot(botId).catch(() => undefined)
      if (!wasMember && token !== null) clearGatewayToken(botId)
      throw error
    }
    this.registry.set(botId, bot)
    return bot
  }
  private async recreate(member: InstalledBot): Promise<void> {
    const bot = new BotRuntime(member.botId, member.slot, this.host)
    try {
      bot.attachScreen(await this.startDisplay(member.botId, member.slot))
      await bot.start()
    } catch (error) {
      await bot.dispose()
      await this.displays?.stopBot(member.botId).catch(() => undefined)
      throw error
    }
    this.registry.set(member.botId, bot)
  }
  /**
   * Starts the bot's apps display. When it cannot start, the bot still gets its own display number, browser area, bus
   * and browser profile, so its computer tools and programs never fall back to the environment display, the
   * environment's session bus or its default browser profile, which every bot shares.
   */
  private async startDisplay(botId: string, slot: number): Promise<BotScreen | null> {
    if (!this.displays) return null
    try {
      const display = await this.displays.startBot(botId, slot)
      return {
        display: display.display,
        width: display.width,
        height: display.height,
        browserArea: display.browserArea,
        env: { ...display.env },
      }
    } catch (error) {
      log('error', `The apps display of bot ${botId} did not start: ${errorMessage(error)}`)
      return {
        display: `:${slot}`,
        width: FLEET_SCREEN.width,
        height: FLEET_SCREEN.height,
        browserArea: fleetEnvironmentTile(slot),
        env: this.fallbackEnv(botId, slot),
      }
    }
  }
  /** The variables the display manager gives a bot's programs: its display, its session bus and its browser. */
  private fallbackEnv(botId: string, slot: number): BotDisplayEnv {
    const paths = botPaths(this.deps.userData, this.deps.home, botId)
    return {
      DISPLAY: `:${slot}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(paths.cache, 'bus')}`,
      BROWSER: BOT_BROWSER,
      MAESTRLY_BOT_BROWSER_PROFILE: path.join(paths.browserConfig, 'chromium'),
    }
  }
  /** Deletes what belongs to one bot only. Its settings go last, so an interrupted purge can run again. */
  private async purge(botId: string, conversationId: string | null): Promise<void> {
    if (conversationId) await this.deps.purgeConversation(conversationId)
    deleteLocalMemorySpace(botMemorySpaceId(botId))
    const { userData, home } = this.deps
    await removeBotFolder(userData, ['fleet-instance', 'bots'], botId)
    await removeBotFolder(userData, ['fleet-inputs'], botId)
    await removeBotFolder(userData, ['fleet-images'], botId)
    await removeBotFolder(home, ['.config', 'maestrly-bots'], botId)
    await removeBotFolder(home, ['.cache', 'maestrly-bots'], botId)
    deleteBotSettings(botId)
    log('info', `Deleted the data of bot ${botId}.`)
  }

  /**
   * The models of the environment's accounts, shared by its bots. Requests while a list loads share it; a forced
   * request starts a new load unless a forced one is already running.
   */
  private accountOptions(force: boolean): Promise<FleetSelectionOption[]> {
    if (this.optionsLoad && (!force || this.optionsLoad.forced)) return this.optionsLoad.promise
    if (!force && this.optionsAt && Date.now() - this.optionsAt < 5_000) return Promise.resolve(this.options)
    const seq = ++this.optionsSeq
    const promise = loadFleetAccountOptions().then((options) => {
      if (seq > this.optionsApplied) {
        this.optionsApplied = seq
        this.options = options
        this.optionsAt = Date.now()
      }
      return options
    })
    const load = { promise, forced: force }
    this.optionsLoad = load
    const clear = () => {
      if (this.optionsLoad === load) this.optionsLoad = null
    }
    promise.then(clear, clear)
    return promise
  }
  /** Account changes reach every bot: each reads its models again and may start queued work. */
  private accountsChanged(): void {
    if (this.disposed) return
    this.optionsAt = 0
    for (const bot of this.registry.values()) bot.accountsChanged()
  }
  private wireBrokers(): void {
    const permission = getChatPermissionBroker()
    const questions = getChatQuestionBroker()
    const asked = (request: PermissionRequest) =>
      this.botForConversation(request.conversationId)?.permissionAsked(request)
    const resolved = (event: { requestId: string; conversationId: string; decision: 'allow' | 'deny' }) =>
      this.botForConversation(event.conversationId)?.permissionResolved(event)
    const questionAsked = (event: { conversationId: string; toolCallId: string }) =>
      this.botForConversation(event.conversationId)?.questionAsked(event)
    const answered = (event: { conversationId: string; toolCallId: string }) =>
      this.botForConversation(event.conversationId)?.questionAnswered(event)
    permission.on('asked', asked)
    permission.on('resolved', resolved)
    questions.on('asked', questionAsked)
    questions.on('answered', answered)
    this.unwireBrokers = () => {
      permission.off('asked', asked)
      permission.off('resolved', resolved)
      questions.off('asked', questionAsked)
      questions.off('answered', answered)
    }
  }

  startLogin(request: FleetLoginStartRequest): Promise<FleetLoginAttempt> {
    return this.logins.start(request)
  }
  login(loginId: string): FleetLoginAttempt {
    return this.logins.get(loginId)
  }
  loginCallback(loginId: string, request: FleetLoginCallbackRequest): Promise<FleetLoginCallbackResponse> {
    return this.logins.callback(loginId, request)
  }
  submitLoginCode(loginId: string, code: string): Promise<FleetLoginAttempt> {
    return this.logins.submitCode(loginId, code)
  }
  cancelLogin(loginId: string): Promise<void> {
    return this.logins.cancel(loginId)
  }
  accounts(): FleetBotAccounts {
    return listBotAccounts({
      connectedProviderIds: new Set(this.options.map((option) => option.providerId)),
      signingIn: this.logins.signingIn(),
    })
  }
  async importAccounts(request: FleetAccountImportRequest): Promise<FleetImportResults> {
    const result = await importBotAccounts(request.items)
    if (result.results.some((item) => item.outcome === 'added' || item.outcome === 'updated')) this.accountsChanged()
    return result
  }
  async removeSubscription(kind: FleetSubscriptionKind, slot: string): Promise<void> {
    await removeBotSubscription(kind, slot)
    this.accountsChanged()
  }
  skills(): Promise<FleetBotSkills> {
    return listBotSkills()
  }
  installSkill(request: FleetSkillInstallRequest): Promise<FleetSkillInstallResponse> {
    return installBotSkill(request)
  }
  removeSkill(name: string): Promise<void> {
    return removeBotSkill(name)
  }
  mcpServers(): FleetBotMcpServers {
    return listBotMcpServers()
  }
  async importMcpServers(request: FleetMcpImportRequest): Promise<FleetImportResults> {
    return importBotMcpServers(request.servers)
  }
  async removeMcpServer(id: string): Promise<void> {
    removeBotMcpServer(id)
  }
  async addApiKeyAccount(value: FleetAddApiKeyAccountRequest): Promise<FleetAddApiKeyAccountResponse> {
    if (apiKeyStorageMode() !== 'secure')
      throw new InstanceHttpError(409, 'CONFLICT', 'Secure credential storage is unavailable.')
    const baseURL =
      value.baseURL ?? (value.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')
    let provider: ReturnType<typeof addProvider>
    try {
      provider = addProvider({ name: value.name, baseURL, kind: value.kind })
    } catch {
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid provider configuration.')
    }
    if (setApiKey(provider.id, value.key) !== 'secure') {
      clearApiKey(provider.id)
      removeProvider(provider.id)
      throw new InstanceHttpError(409, 'CONFLICT', 'Secure credential storage is unavailable.')
    }
    this.accountsChanged()
    return { providerId: provider.id }
  }
  async removeAccount(providerId: string): Promise<void> {
    if (!listProviders().some((provider) => provider.id === providerId))
      throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
    removeProvider(providerId)
    clearApiKey(providerId)
    invalidateProvider(providerId)
    invalidateModels(providerId)
    if (getAppSetting('chat.defaultProvider') === providerId) {
      setAppSetting('chat.defaultProvider', '')
      setAppSetting('chat.defaultModel', '')
      setAppSetting('chat.defaultReasoning', 'off')
    }
    this.options = this.options.filter((option) => option.providerId !== providerId)
    this.optionsAt = 0
    await Promise.all(this.bots().map((bot) => bot.accountRemoved(providerId)))
  }
  async open(target: FleetUiOpenRequest['target']): Promise<void> {
    await this.deps.openSettings(target)
  }
}

/**
 * Runs the display manager's programs. `options.env` holds only the variables set over this process's environment,
 * so each child gets both. A program that cannot start exits with 127, like a shell's "command not found".
 */
export function productionDisplayDeps(home: string): DisplayManagerDeps {
  return {
    spawn(command, args, options) {
      let child: ChildProcess
      try {
        child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: 'ignore' })
      } catch (error) {
        log('error', `Could not start ${command}: ${errorMessage(error)}`)
        return { exited: Promise.resolve(127), kill: () => {} }
      }
      const exited = new Promise<number | null>((resolve) => {
        child.once('error', (error) => {
          log('error', `Could not run ${command}: ${error.message}`)
          resolve(127)
        })
        child.once('exit', (code) => resolve(code))
      })
      return {
        exited,
        kill: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        },
      }
    },
    home,
    mkdir: async (folder) => {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 })
    },
    setTimeout,
    clearTimeout,
    log: (message) => log('info', message),
  }
}
