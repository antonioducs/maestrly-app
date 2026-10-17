import {
  type FleetAccountImportRequest,
  type FleetAddApiKeyAccountRequest,
  type FleetLoginCallbackRequest,
  type FleetLoginStartRequest,
  type FleetMcpImportRequest,
  type FleetSkillInstallRequest,
  type FleetSubscriptionKind,
  FLEET_CONVERSATION_COMPUTERS_FEATURE,
  FLEET_HOST_EDITOR_FEATURE,
  FLEET_HOST_FILES_FEATURE,
  FLEET_HOST_FILES_FOLDERS_FEATURE,
  FLEET_HOST_DESKTOP_CALLS_FEATURE,
  FLEET_MOBILE_HOST_FEATURE,
  FLEET_WORKSPACES_HOST_FEATURE,
  type ScreenMode,
} from '@maestrly/bot-fleet-protocol'
import type { EnvironmentRuntime } from '../../fleet/instance/environment'
import { type InstanceEnvironment, InstanceHttpError, type InstanceScreenSurface } from '../../fleet/instance/server'
import { ComputerUnavailableError, type ConversationComputers } from './computers'

/** The computers of the host's conversations, and how to tell a conversation it has from one it does not. */
export interface HostComputers {
  computers: Pick<ConversationComputers, 'acquireScreen'>
  conversationExists(conversationId: string): boolean
}

const notBots = (): InstanceHttpError =>
  new InstanceHttpError(409, 'CONFLICT', 'This environment hosts workspaces, not bots.')

/**
 * What a workspaces host answers on the control API a bot environment serves: it reports itself to the gateway and
 * takes accounts, sign-ins, skills and MCP servers with the code a bot environment runs (an environment runtime with
 * no bots), and it refuses everything about bots. Its only screens are its conversations' computers and browsers, when
 * it has computers. Its environment settings are the profile its chats use. Its chats and workspaces are not here:
 * they are reached over the bridge.
 */
export class HostEnvironment implements InstanceEnvironment {
  readonly events: InstanceEnvironment['events']
  readonly settings: InstanceEnvironment['settings']

  constructor(
    private readonly runtime: EnvironmentRuntime,
    /** Whether chat turns are running: a scheduled update of the host waits for them. */
    private readonly busy: () => boolean,
    private readonly computers: HostComputers | null = null,
    /** Whether it takes the calls of the bots it gives access to (`host-desktop-calls`): it has a host token. */
    private readonly desktopCalls = false
  ) {
    this.events = runtime.events
    this.settings = runtime.settings
  }

  health() {
    const health = this.runtime.health()
    return { ...health, capabilities: [...health.capabilities, ...this.hostCapabilities()], busy: this.busy() }
  }
  async environmentStatus() {
    const status = await this.runtime.environmentStatus()
    return { ...status, capabilities: [...status.capabilities, ...this.hostCapabilities()], bots: [] }
  }
  private hostCapabilities(): string[] {
    return [
      FLEET_WORKSPACES_HOST_FEATURE,
      FLEET_HOST_FILES_FEATURE,
      FLEET_HOST_FILES_FOLDERS_FEATURE,
      FLEET_HOST_EDITOR_FEATURE,
      FLEET_MOBILE_HOST_FEATURE,
      ...(this.computers ? [FLEET_CONVERSATION_COMPUTERS_FEATURE] : []),
      ...(this.desktopCalls ? [FLEET_HOST_DESKTOP_CALLS_FEATURE] : []),
    ]
  }
  selections() {
    return this.runtime.selections()
  }

  bot(): never {
    throw notBots()
  }
  async installBot(): Promise<never> {
    throw notBots()
  }
  async uninstallBot(): Promise<never> {
    throw notBots()
  }
  /** A conversation's computer or browser tile; every other screen belongs to bots. */
  async acquireScreen(surface: InstanceScreenSurface, mode: ScreenMode) {
    if (surface.kind !== 'conversation' || !this.computers) throw notBots()
    if (!this.computers.conversationExists(surface.conversationId))
      throw new InstanceHttpError(404, 'NOT_FOUND', 'Conversation not found.')
    try {
      return await this.computers.computers.acquireScreen(surface.conversationId, surface.surface, mode)
    } catch (error) {
      if (error instanceof ComputerUnavailableError) throw new InstanceHttpError(409, 'CONFLICT', error.message)
      throw error
    }
  }
  async open(): Promise<never> {
    throw notBots()
  }

  startLogin(request: FleetLoginStartRequest) {
    return this.runtime.startLogin(request)
  }
  login(loginId: string) {
    return this.runtime.login(loginId)
  }
  loginCallback(loginId: string, request: FleetLoginCallbackRequest) {
    return this.runtime.loginCallback(loginId, request)
  }
  submitLoginCode(loginId: string, code: string) {
    return this.runtime.submitLoginCode(loginId, code)
  }
  cancelLogin(loginId: string) {
    return this.runtime.cancelLogin(loginId)
  }
  accounts() {
    return this.runtime.accounts()
  }
  importAccounts(request: FleetAccountImportRequest) {
    return this.runtime.importAccounts(request)
  }
  removeSubscription(kind: FleetSubscriptionKind, slot: string) {
    return this.runtime.removeSubscription(kind, slot)
  }
  skills() {
    return this.runtime.skills()
  }
  installSkill(request: FleetSkillInstallRequest) {
    return this.runtime.installSkill(request)
  }
  removeSkill(name: string) {
    return this.runtime.removeSkill(name)
  }
  mcpServers() {
    return this.runtime.mcpServers()
  }
  importMcpServers(request: FleetMcpImportRequest) {
    return this.runtime.importMcpServers(request)
  }
  removeMcpServer(id: string) {
    return this.runtime.removeMcpServer(id)
  }
  addApiKeyAccount(value: FleetAddApiKeyAccountRequest) {
    return this.runtime.addApiKeyAccount(value)
  }
  removeAccount(providerId: string) {
    return this.runtime.removeAccount(providerId)
  }
  checkRuntimes() {
    this.runtime.checkRuntimes()
  }
}
