import {
  type FleetAccountImportRequest,
  type FleetAddApiKeyAccountRequest,
  type FleetLoginCallbackRequest,
  type FleetLoginStartRequest,
  type FleetMcpImportRequest,
  type FleetSkillInstallRequest,
  type FleetSubscriptionKind,
  FLEET_HOST_EDITOR_FEATURE,
  FLEET_HOST_FILES_FEATURE,
  FLEET_MOBILE_HOST_FEATURE,
  FLEET_WORKSPACES_HOST_FEATURE,
} from '@maestrly/bot-fleet-protocol'
import type { EnvironmentRuntime } from '../../fleet/instance/environment'
import { type InstanceEnvironment, InstanceHttpError } from '../../fleet/instance/server'

const notBots = (): InstanceHttpError =>
  new InstanceHttpError(409, 'CONFLICT', 'This environment hosts workspaces, not bots.')

/**
 * What a workspaces host answers on the control API a bot environment serves: it reports itself to the gateway and
 * takes accounts, sign-ins, skills and MCP servers with the code a bot environment runs (an environment runtime with
 * no bots), and it refuses everything about bots and screens. Its environment settings are the profile its chats use.
 * Its chats and workspaces are not here: they are reached over the bridge.
 */
export class HostEnvironment implements InstanceEnvironment {
  readonly events: InstanceEnvironment['events']
  readonly settings: InstanceEnvironment['settings']

  constructor(
    private readonly runtime: EnvironmentRuntime,
    /** Whether chat turns are running: a scheduled update of the host waits for them. */
    private readonly busy: () => boolean
  ) {
    this.events = runtime.events
    this.settings = runtime.settings
  }

  health() {
    const health = this.runtime.health()
    return {
      ...health,
      capabilities: [
        ...health.capabilities,
        FLEET_WORKSPACES_HOST_FEATURE,
        FLEET_HOST_FILES_FEATURE,
        FLEET_HOST_EDITOR_FEATURE,
        FLEET_MOBILE_HOST_FEATURE,
      ],
      busy: this.busy(),
    }
  }
  async environmentStatus() {
    const status = await this.runtime.environmentStatus()
    return {
      ...status,
      capabilities: [
        ...status.capabilities,
        FLEET_WORKSPACES_HOST_FEATURE,
        FLEET_HOST_FILES_FEATURE,
        FLEET_HOST_EDITOR_FEATURE,
        FLEET_MOBILE_HOST_FEATURE,
      ],
      bots: [],
    }
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
  async acquireScreen(): Promise<never> {
    throw notBots()
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
