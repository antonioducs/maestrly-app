import {
  FLEET_SETTINGS_OPERATIONS,
  type FleetSettingsInput,
  type FleetSettingsOutput,
} from '@maestrly/bot-fleet-protocol'
import {
  FLEET_INSTANCE_ROUTES,
  FLEET_FILE_LIMITS,
  fleetFileIdSchema,
  type FleetFileRef,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_IMAGE_LIMITS,
  FLEET_REASONING_QUERY,
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
    timeoutMs = this.timeoutMs,
    signal?: AbortSignal
  ): Promise<any> {
    const route = FLEET_INSTANCE_ROUTES[key]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response, text: string
    try {
      response = await fetch(this.origin + buildPath(route.path, params, query), {
        method: route.method,
        redirect: 'error',
        headers: {
          [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
          Authorization: 'Bearer ' + this.controlToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
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
  async settingsAccounts(input: FleetSettingsInput<'accounts'>): Promise<FleetSettingsOutput<'accounts'>> {
    FLEET_SETTINGS_OPERATIONS.accounts.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.accounts.response.parse(
      await this.call('settingsAccounts', {}, undefined, undefined, 30000)
    )
  }
  async settingsPatchAccount(input: FleetSettingsInput<'patchAccount'>): Promise<FleetSettingsOutput<'patchAccount'>> {
    FLEET_SETTINGS_OPERATIONS.patchAccount.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.patchAccount.response.parse(
      await this.call('settingsPatchAccount', { providerId: input.providerId }, undefined, input, 30000)
    )
  }
  async settingsRenameSubscription(
    input: FleetSettingsInput<'renameSubscription'>
  ): Promise<FleetSettingsOutput<'renameSubscription'>> {
    return FLEET_SETTINGS_OPERATIONS.renameSubscription.response.parse(
      await this.call(
        'settingsRenameSubscription',
        { kind: input.kind, slot: input.slot ?? 'default' },
        undefined,
        input,
        30000
      )
    )
  }
  async settingsRemoveAccount(
    input: FleetSettingsInput<'removeAccount'>
  ): Promise<FleetSettingsOutput<'removeAccount'>> {
    return FLEET_SETTINGS_OPERATIONS.removeAccount.response.parse(
      await this.call('settingsRemoveAccount', { providerId: input.providerId }, undefined, input, 30000)
    )
  }
  async settingsRemoveSubscription(
    input: FleetSettingsInput<'removeSubscription'>
  ): Promise<FleetSettingsOutput<'removeSubscription'>> {
    return FLEET_SETTINGS_OPERATIONS.removeSubscription.response.parse(
      await this.call(
        'settingsRemoveSubscription',
        { kind: input.kind, slot: input.slot ?? 'default' },
        undefined,
        input,
        30000
      )
    )
  }
  async settingsModels(input: FleetSettingsInput<'models'>): Promise<FleetSettingsOutput<'models'>> {
    FLEET_SETTINGS_OPERATIONS.models.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.models.response.parse(
      await this.call('settingsModels', {}, undefined, undefined, 30000)
    )
  }
  async settingsSetModelFilter(
    input: FleetSettingsInput<'setModelFilter'>
  ): Promise<FleetSettingsOutput<'setModelFilter'>> {
    return FLEET_SETTINGS_OPERATIONS.setModelFilter.response.parse(
      await this.call('settingsSetModelFilter', { providerId: input.providerId }, undefined, input, 30000)
    )
  }
  async settingsSkills(input: FleetSettingsInput<'skills'>): Promise<FleetSettingsOutput<'skills'>> {
    FLEET_SETTINGS_OPERATIONS.skills.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.skills.response.parse(
      await this.call('settingsSkills', {}, undefined, undefined, 30000)
    )
  }
  async settingsSkill(input: FleetSettingsInput<'skill'>): Promise<FleetSettingsOutput<'skill'>> {
    FLEET_SETTINGS_OPERATIONS.skill.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.skill.response.parse(
      await this.call('settingsSkill', { name: input.name }, undefined, undefined, 30000)
    )
  }
  async settingsCreateSkill(input: FleetSettingsInput<'createSkill'>): Promise<FleetSettingsOutput<'createSkill'>> {
    FLEET_SETTINGS_OPERATIONS.createSkill.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.createSkill.response.parse(
      await this.call('settingsCreateSkill', {}, undefined, input, 30000)
    )
  }
  async settingsWriteSkill(input: FleetSettingsInput<'writeSkill'>): Promise<FleetSettingsOutput<'writeSkill'>> {
    FLEET_SETTINGS_OPERATIONS.writeSkill.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.writeSkill.response.parse(
      await this.call('settingsWriteSkill', { name: input.name }, undefined, input, 30000)
    )
  }
  async settingsSetSkillEnabled(
    input: FleetSettingsInput<'setSkillEnabled'>
  ): Promise<FleetSettingsOutput<'setSkillEnabled'>> {
    return FLEET_SETTINGS_OPERATIONS.setSkillEnabled.response.parse(
      await this.call('settingsSetSkillEnabled', { name: input.name }, undefined, input, 30000)
    )
  }
  async settingsRemoveSkill(input: FleetSettingsInput<'removeSkill'>): Promise<FleetSettingsOutput<'removeSkill'>> {
    FLEET_SETTINGS_OPERATIONS.removeSkill.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.removeSkill.response.parse(
      await this.call('settingsRemoveSkill', { name: input.name }, undefined, input, 30000)
    )
  }
  async settingsSearchSkills(input: FleetSettingsInput<'searchSkills'>): Promise<FleetSettingsOutput<'searchSkills'>> {
    FLEET_SETTINGS_OPERATIONS.searchSkills.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.searchSkills.response.parse(
      await this.call('settingsSearchSkills', {}, undefined, input, 30000)
    )
  }
  async settingsInstallSkill(input: FleetSettingsInput<'installSkill'>): Promise<FleetSettingsOutput<'installSkill'>> {
    FLEET_SETTINGS_OPERATIONS.installSkill.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.installSkill.response.parse(
      await this.call('settingsInstallSkill', {}, undefined, input, 120000)
    )
  }
  async settingsSkillGroups(input: FleetSettingsInput<'skillGroups'>): Promise<FleetSettingsOutput<'skillGroups'>> {
    FLEET_SETTINGS_OPERATIONS.skillGroups.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.skillGroups.response.parse(
      await this.call('settingsSkillGroups', {}, undefined, undefined, 30000)
    )
  }
  async settingsCreateSkillGroup(
    input: FleetSettingsInput<'createSkillGroup'>
  ): Promise<FleetSettingsOutput<'createSkillGroup'>> {
    return FLEET_SETTINGS_OPERATIONS.createSkillGroup.response.parse(
      await this.call('settingsCreateSkillGroup', {}, undefined, input, 30000)
    )
  }
  async settingsUpdateSkillGroup(
    input: FleetSettingsInput<'updateSkillGroup'>
  ): Promise<FleetSettingsOutput<'updateSkillGroup'>> {
    return FLEET_SETTINGS_OPERATIONS.updateSkillGroup.response.parse(
      await this.call('settingsUpdateSkillGroup', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsRemoveSkillGroup(
    input: FleetSettingsInput<'removeSkillGroup'>
  ): Promise<FleetSettingsOutput<'removeSkillGroup'>> {
    return FLEET_SETTINGS_OPERATIONS.removeSkillGroup.response.parse(
      await this.call('settingsRemoveSkillGroup', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsMcpServers(input: FleetSettingsInput<'mcpServers'>): Promise<FleetSettingsOutput<'mcpServers'>> {
    FLEET_SETTINGS_OPERATIONS.mcpServers.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.mcpServers.response.parse(
      await this.call('settingsMcpServers', {}, undefined, undefined, 30000)
    )
  }
  async settingsMcpServer(input: FleetSettingsInput<'mcpServer'>): Promise<FleetSettingsOutput<'mcpServer'>> {
    FLEET_SETTINGS_OPERATIONS.mcpServer.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.mcpServer.response.parse(
      await this.call('settingsMcpServer', { id: input.id }, undefined, undefined, 30000)
    )
  }
  async settingsCreateMcpServer(
    input: FleetSettingsInput<'createMcpServer'>
  ): Promise<FleetSettingsOutput<'createMcpServer'>> {
    return FLEET_SETTINGS_OPERATIONS.createMcpServer.response.parse(
      await this.call('settingsCreateMcpServer', {}, undefined, input, 30000)
    )
  }
  async settingsPatchMcpServer(
    input: FleetSettingsInput<'patchMcpServer'>
  ): Promise<FleetSettingsOutput<'patchMcpServer'>> {
    return FLEET_SETTINGS_OPERATIONS.patchMcpServer.response.parse(
      await this.call('settingsPatchMcpServer', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsRemoveMcpServer(
    input: FleetSettingsInput<'removeMcpServer'>
  ): Promise<FleetSettingsOutput<'removeMcpServer'>> {
    return FLEET_SETTINGS_OPERATIONS.removeMcpServer.response.parse(
      await this.call('settingsRemoveMcpServer', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsTestMcpServer(
    input: FleetSettingsInput<'testMcpServer'>
  ): Promise<FleetSettingsOutput<'testMcpServer'>> {
    return FLEET_SETTINGS_OPERATIONS.testMcpServer.response.parse(
      await this.call('settingsTestMcpServer', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsRuntimes(input: FleetSettingsInput<'runtimes'>): Promise<FleetSettingsOutput<'runtimes'>> {
    FLEET_SETTINGS_OPERATIONS.runtimes.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.runtimes.response.parse(
      await this.call('settingsRuntimes', {}, undefined, undefined, 30000)
    )
  }
  async settingsRuntimeAction(
    input: FleetSettingsInput<'runtimeAction'>
  ): Promise<FleetSettingsOutput<'runtimeAction'>> {
    return FLEET_SETTINGS_OPERATIONS.runtimeAction.response.parse(
      await this.call('settingsRuntimeAction', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsSetRuntimeAutomatic(
    input: FleetSettingsInput<'setRuntimeAutomatic'>
  ): Promise<FleetSettingsOutput<'setRuntimeAutomatic'>> {
    return FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.response.parse(
      await this.call('settingsSetRuntimeAutomatic', { id: input.id }, undefined, input, 30000)
    )
  }
  async settingsPreferences(input: FleetSettingsInput<'preferences'>): Promise<FleetSettingsOutput<'preferences'>> {
    FLEET_SETTINGS_OPERATIONS.preferences.input.parse(input)
    return FLEET_SETTINGS_OPERATIONS.preferences.response.parse(
      await this.call('settingsPreferences', {}, undefined, undefined, 30000)
    )
  }
  async settingsSetPreferences(
    input: FleetSettingsInput<'setPreferences'>
  ): Promise<FleetSettingsOutput<'setPreferences'>> {
    return FLEET_SETTINGS_OPERATIONS.setPreferences.response.parse(
      await this.call('settingsSetPreferences', {}, undefined, input, 30000)
    )
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
  /** Starts the environment's runtime checks; they run in the background there. */
  runtimesCheck(): Promise<{ ok: true }> {
    return this.call('runtimesCheck')
  }
  /** The model options of the environment's accounts, for its default compaction model (`environment-compaction`). */
  environmentSelections() {
    return this.call('environmentSelections')
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
  /** A page of the bot's transcript; with `reasoning`, the `reasoning` items too (an older bot sends none). */
  transcript(before?: string, limit = 200, reasoning = false) {
    return this.botCall(
      'transcript',
      'botTranscript',
      {},
      { before, limit, [FLEET_REASONING_QUERY]: reasoning ? 1 : undefined }
    )
  }
  async fileMeta(fileId: string, signal?: AbortSignal): Promise<FleetFileRef> {
    if (!fleetFileIdSchema.safeParse(fileId).success || !this.scope)
      throw new GatewayError('INVALID_REQUEST', 'Invalid file request')
    const ref: FleetFileRef = await this.call(
      'botFileMeta',
      { botId: this.scope.botId, fileId },
      undefined,
      undefined,
      this.timeoutMs,
      signal
    )
    if (ref.id !== fileId) throw invalidResponse()
    return ref
  }
  async file(fileId: string, signal?: AbortSignal): Promise<Response> {
    if (!fleetFileIdSchema.safeParse(fileId).success || !this.scope)
      throw new GatewayError('INVALID_REQUEST', 'Invalid file request')
    let response: Response | undefined
    try {
      response = await fetch(
        this.origin +
          buildPath(FLEET_INSTANCE_ROUTES.botFile.path, {
            botId: this.scope.botId,
            fileId,
          }),
        {
          headers: {
            [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
            Authorization: 'Bearer ' + this.controlToken,
          },
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
        }
      )
      if (response.status === 404) throw new GatewayError('NOT_FOUND', 'File not found')
      const length = response.headers.get('content-length')
      const type = response.headers.get('content-type') ?? ''
      if (
        response.status !== 200 ||
        !response.body ||
        length === null ||
        !/^\d+$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        Number(length) > FLEET_FILE_LIMITS.downloadMaxBytes ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type) ||
        (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')
      )
        throw invalidResponse()
      return response
    } catch (error) {
      await response?.body?.cancel().catch(() => undefined)
      if (error instanceof GatewayError) throw error
      throw new InstanceUnreachableError()
    }
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
      // The gateway reads `reasoning` items and passes them on only to devices that ask for them.
      const query = { since, [FLEET_REASONING_QUERY]: 1 }
      response = await fetch(this.origin + buildPath(FLEET_INSTANCE_ROUTES.events.path, {}, query), {
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
