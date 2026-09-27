import {
  FLEET_INSTANCE_ROUTES,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_IMAGE_LIMITS,
  fleetImageMediaTypeSchema,
  buildPath,
  fleetInstanceEventSchema,
  type FleetBotMemoryPatchRequest,
  type FleetInstanceBotInstall,
  type FleetInstanceEnvironmentStatus,
  type FleetInstanceInput,
  type FleetInstanceStatus,
  type FleetInstanceProfile,
  type FleetInteractionResolution,
  type FleetAddApiKeyAccountRequest,
  type FleetConversationCallRequest,
  type FleetUiOpenRequest,
  type FleetAccountImportRequest,
  type FleetImportResults,
  type FleetLoginStartRequest,
  type FleetLoginCallbackRequest,
  type FleetSkillInstallRequest,
  type FleetSkillInstallResponse,
  type FleetMcpImportRequest,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

type Routes = typeof FLEET_INSTANCE_ROUTES
/**
 * An instance that could not be reached, or did not answer in time: its whole environment is unavailable. An instance
 * that answers, even with an error or an unusable answer about one bot, is reachable.
 */
export class InstanceUnreachableError extends GatewayError {
  constructor() {
    super('INSTANCE_UNAVAILABLE', 'Bot instance unavailable')
  }
}
const invalidResponse = () => new GatewayError('INSTANCE_UNAVAILABLE', 'Invalid bot instance response')
/**
 * The bot a client speaks for. An instance with the `environments` capability serves each bot under
 * `/v1/bots/:botId`; an older one runs a single bot on the unprefixed routes.
 */
export type InstanceBotScope = { botId: string; environments: boolean }
/**
 * The control API of an environment's Maestrly. Accounts, subscriptions, sign-ins, skills, MCP servers, the settings
 * window and the event stream belong to the environment; `forBot` gives a client whose conversation, queue, hold and
 * memory calls address one of its bots.
 */
export class InstanceClient {
  constructor(
    readonly environmentId: string,
    readonly controlToken: string,
    readonly origin = 'http://maestrly-env-' + environmentId + ':7680',
    readonly timeoutMs = 15000,
    readonly scope: InstanceBotScope | null = null
  ) {}
  /** The same instance, addressing one bot: through its own routes when the instance has environments. */
  forBot(botId: string, environments: boolean): InstanceClient {
    return new InstanceClient(this.environmentId, this.controlToken, this.origin, this.timeoutMs, {
      botId,
      environments,
    })
  }
  /**
   * A bot call: the prefixed route of an environment instance, or the route an older instance (whose one bot needs no
   * name) has always had.
   */
  private botCall<L extends keyof Routes, P extends keyof Routes>(
    legacy: L,
    prefixed: P,
    params: Record<string, string> = {},
    query?: Record<string, string | number | undefined>,
    body?: unknown,
    timeoutMs?: number
  ): Promise<any> {
    return this.scope?.environments
      ? this.call(prefixed, { ...params, botId: this.scope.botId }, query, body, timeoutMs)
      : this.call(legacy, params, query, body, timeoutMs)
  }
  private async call<K extends keyof Routes>(
    key: K,
    params: Record<string, string> = {},
    query?: Record<string, string | number | undefined>,
    body?: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<any> {
    const route = FLEET_INSTANCE_ROUTES[key]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response, text: string
    try {
      response = await fetch(this.origin + buildPath(route.path, params, query), {
        method: route.method,
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + this.controlToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      text = await response.text()
    } catch {
      throw new InstanceUnreachableError()
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      let code = 'INSTANCE_UNAVAILABLE'
      let message = 'Bot instance request failed'
      try {
        const value = JSON.parse(text) as { code?: string; message?: string }
        if (value.code) code = value.code
        if (typeof value.message === 'string') message = value.message
      } catch {}
      throw new GatewayError(
        code === 'CONFLICT'
          ? 'CONFLICT'
          : code === 'INVALID_REQUEST'
            ? 'INVALID_REQUEST'
            : code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : 'INSTANCE_UNAVAILABLE',
        message
      )
    }
    // A route that answers with a body is never taken to have succeeded without one.
    if (response.status === 204) {
      if (route.response) throw invalidResponse()
      return undefined
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw invalidResponse()
    }
    if (!route.response) return value
    const parsed = route.response.safeParse(value)
    if (!parsed.success) throw invalidResponse()
    return parsed.data
  }
  // instance.ts
  memoriesList(status: 'active' | 'archived' | 'superseded' | 'all' = 'active') {
    return this.botCall('memoriesList', 'botMemoriesList', {}, { status })
  }
  memoryPatch(id: string, body: FleetBotMemoryPatchRequest) {
    return this.botCall('memoryPatch', 'botMemoryPatch', { id }, undefined, body)
  }
  memoryDelete(id: string) {
    return this.botCall('memoryDelete', 'botMemoryDelete', { id })
  }

  health() {
    return this.call('health')
  }
  status(): Promise<FleetInstanceStatus> {
    return this.botCall('status', 'botStatus')
  }
  /** Installs a bot on an instance that predates environments, which runs a single bot. */
  putProfile(body: FleetInstanceProfile): Promise<FleetInstanceStatus> {
    return this.call('profile', {}, undefined, body)
  }
  environmentStatus(): Promise<FleetInstanceEnvironmentStatus> {
    return this.call('environmentStatus')
  }
  /** Installs a bot in the environment, or updates it: its profile, display slot and gateway token. */
  botInstall(botId: string, body: FleetInstanceBotInstall): Promise<FleetInstanceStatus> {
    return this.call('botInstall', { botId }, undefined, body)
  }
  /** Uninstalls a bot and keeps its data, or with `purge` deletes its conversation, memory space and folders too. */
  botUninstall(botId: string, purge: boolean): Promise<void> {
    return this.call('botUninstall', { botId }, purge ? { purge: 1 } : undefined)
  }
  selections() {
    return this.botCall('selections', 'botSelections')
  }
  addApiKeyAccount(body: FleetAddApiKeyAccountRequest) {
    return this.call('apiKeyAccountAdd', {}, undefined, body)
  }
  accountsList() {
    return this.call('accountsList')
  }
  accountsImport(body: FleetAccountImportRequest): Promise<FleetImportResults> {
    return this.call('accountsImport', {}, undefined, body)
  }
  subscriptionRemove(kind: string, slot: string) {
    return this.call('subscriptionRemove', { kind, slot })
  }
  loginStart(body: FleetLoginStartRequest) {
    return this.call('loginStart', {}, undefined, body, 30000)
  }
  loginGet(lid: string) {
    return this.call('loginGet', { lid })
  }
  loginCallback(lid: string, body: FleetLoginCallbackRequest) {
    return this.call('loginCallback', { lid }, undefined, body)
  }
  loginCode(lid: string, body: { code: string }) {
    return this.call('loginCode', { lid }, undefined, body)
  }
  loginCancel(lid: string) {
    return this.call('loginCancel', { lid })
  }
  skillsList() {
    return this.call('skillsList')
  }
  skillInstall(body: FleetSkillInstallRequest): Promise<FleetSkillInstallResponse> {
    return this.call('skillInstall', {}, undefined, body, 60000)
  }
  skillRemove(name: string) {
    return this.call('skillRemove', { name })
  }
  mcpServersList() {
    return this.call('mcpServersList')
  }
  mcpServersImport(body: FleetMcpImportRequest): Promise<FleetImportResults> {
    return this.call('mcpServersImport', {}, undefined, body)
  }
  mcpServerRemove(sid: string) {
    return this.call('mcpServerRemove', { sid })
  }
  removeAccount(providerId: string) {
    return this.call('accountRemove', { providerId })
  }
  transcript(before?: string, limit = 200) {
    return this.botCall('transcript', 'botTranscript', {}, { before, limit })
  }
  async image(imageId: string): Promise<Response> {
    const path = this.scope?.environments
      ? buildPath(FLEET_INSTANCE_ROUTES.botImage.path, { botId: this.scope.botId, imageId })
      : buildPath(FLEET_INSTANCE_ROUTES.image.path, { imageId })
    try {
      const response = await fetch(this.origin + path, {
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + this.controlToken,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.status === 404) throw new GatewayError('NOT_FOUND', 'Image not found')
      if (!response.ok || !response.body) throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot image unavailable')
      const mediaType = response.headers.get('content-type')
      const size = Number(response.headers.get('content-length'))
      if (
        !fleetImageMediaTypeSchema.safeParse(mediaType).success ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > FLEET_IMAGE_LIMITS.imageReadMaxBytes
      )
        throw new GatewayError('INSTANCE_UNAVAILABLE', 'Invalid bot image response')
      return response
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot image unavailable')
    }
  }
  postInput(body: FleetInstanceInput) {
    return this.botCall('inputSend', 'botInputSend', {}, undefined, body)
  }
  deleteInput(inputId: string) {
    return this.botCall('inputDelete', 'botInputDelete', { inputId })
  }
  cancelTurn() {
    return this.botCall('turnCancel', 'botTurnCancel')
  }
  resolveInteraction(id: string, body: FleetInteractionResolution) {
    return this.botCall('interactionResolve', 'botInteractionResolve', { id }, undefined, body)
  }
  hold(body: { reason: 'takeover' | 'paused' }) {
    return this.botCall('hold', 'botHold', {}, undefined, body)
  }
  release(body: { note: string | null; durationMs: number | null; continue: boolean }) {
    return this.botCall('holdRelease', 'botHoldRelease', {}, undefined, body)
  }
  conversationCall(body: FleetConversationCallRequest) {
    return this.botCall('conversationCall', 'botConversationCall', {}, undefined, body)
  }
  uiOpen(body: FleetUiOpenRequest) {
    return this.call('uiOpen', {}, undefined, body)
  }
  async *events(since = 0, signal?: AbortSignal) {
    let response: Response
    try {
      response = await fetch(this.origin + buildPath(FLEET_INSTANCE_ROUTES.events.path, {}, { since }), {
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + this.controlToken,
        },
        signal,
      })
    } catch {
      if (signal?.aborted) return
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot instance event stream unavailable')
    }
    if (!response.ok || !response.body)
      throw new GatewayError('INSTANCE_UNAVAILABLE', 'Bot instance event stream unavailable')
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary).replace(/\r/g, '')
          buffer = buffer.slice(boundary + 2)
          const lines = frame.split('\n')
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          const id = lines
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim()
          if (data) {
            const event = fleetInstanceEventSchema.parse(JSON.parse(data))
            if (id && Number(id) !== event.seq)
              throw new GatewayError('INSTANCE_UNAVAILABLE', 'Invalid instance event sequence')
            yield event
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!signal?.aborted)
        throw error instanceof GatewayError
          ? error
          : new GatewayError('INSTANCE_UNAVAILABLE', 'Invalid bot instance event stream')
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
}
