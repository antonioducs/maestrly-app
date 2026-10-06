import {
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  FLEET_SETTINGS_OPERATIONS,
  type FleetEnvironmentSettingsService,
} from '@maestrly/bot-fleet-protocol'
import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { Transform, type Duplex, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  FLEET_CONTEXT_LIMIT_FEATURE,
  FLEET_DESKTOP_BRIDGE_FEATURE,
  FLEET_FILES_FEATURE,
  FLEET_ENVIRONMENT_COMPACTION_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_INSTANCE_ROUTES,
  FLEET_MESSAGE_BODY_MAX,
  FLEET_PROTOCOL_HEADER,
  FLEET_PROTOCOL_VERSION,
  FLEET_PROVISIONING_FEATURE,
  FLEET_RUNTIME_UPDATES_FEATURE,
  FLEET_SCREEN_UPGRADE,
  FLEET_SKILL_BODY_MAX,
  FLEET_TRANSCRIPT_REASONING_FEATURE,
  fleetAccountSlotIdSchema,
  fleetBotIdSchema,
  fleetFileIdSchema,
  fleetFileRefSchema,
  fleetInstanceEventSchema,
  fleetReaderWantsReasoning,
  fleetTranscriptItemReadable,
  fleetScreenSurfaceSchema,
  fleetSubscriptionKindSchema,
  type FleetAccountImportRequest,
  type FleetAddApiKeyAccountRequest,
  type FleetAddApiKeyAccountResponse,
  type FleetBotAccounts,
  type FleetBotMcpServers,
  type FleetBotMemory,
  type FleetBotMemoryPatchRequest,
  type FleetBotSkills,
  type FleetConversationCallRequest,
  type FleetFileRef,
  type FleetImportResults,
  type FleetInputReceipt,
  type FleetInstanceBotInstall,
  type FleetInstanceEnvironmentStatus,
  type FleetInstanceEvent,
  type FleetInstanceHold,
  type FleetInstanceInput,
  type FleetInstanceReleaseRequest,
  type FleetInstanceStatus,
  type FleetInteractionResolution,
  type FleetLoginAttempt,
  type FleetLoginCallbackRequest,
  type FleetLoginCallbackResponse,
  type FleetLoginStartRequest,
  type FleetMcpImportRequest,
  type FleetSelection,
  type FleetSelectionOption,
  type FleetSkillInstallRequest,
  type FleetSkillInstallResponse,
  type FleetSubscriptionKind,
  type FleetTranscriptPage,
  type FleetUiOpenRequest,
} from '@maestrly/bot-fleet-protocol'
import type { z } from 'zod'
import type { BotInstanceConfig } from './config'
import type { DisplaySurface, VncLease, VncMode } from './displays'

export class InstanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/**
 * What this instance offers: provisioning of its environment (accounts, skills, MCP servers, sign-ins), several bots,
 * each addressed by id under `/v1/bots/:botId`, the list of its models for the environment's default compaction
 * model, caps each bot's conversation at the context limit of its compaction settings, sends the model's reasoning
 * in transcripts to readers that ask for it, reports the versions of its Claude Code and Codex with checks for
 * newer ones, and gives its bots the desktop_* tools that reach the Macs that linked them. Its health and every status
 * advertise them.
 */
export const INSTANCE_CAPABILITIES: readonly string[] = [
  FLEET_FILES_FEATURE,
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  FLEET_PROVISIONING_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_ENVIRONMENT_COMPACTION_FEATURE,
  FLEET_CONTEXT_LIMIT_FEATURE,
  FLEET_TRANSCRIPT_REASONING_FEATURE,
  FLEET_RUNTIME_UPDATES_FEATURE,
  FLEET_DESKTOP_BRIDGE_FEATURE,
]

type MemoryStatus = 'active' | 'archived' | 'superseded' | 'all'
const MEMORY_STATUSES: readonly string[] = ['active', 'archived', 'superseded', 'all']

export type InstanceFile = { ref: FleetFileRef; stream: Readable }

/** One bot of the environment, as the control API reaches it. */
export interface InstanceBot {
  readonly botId: string
  /** Its display slot: tile `slot` of the environment display holds its browser, and `:slot` is its apps display. */
  readonly slot: number
  /** Its hold right now, so screen control follows a takeover without waiting for the next status. */
  readonly holdManager: { readonly state: FleetInstanceHold }
  status(): Promise<FleetInstanceStatus>
  selections(): Promise<{ options: FleetSelectionOption[]; current: FleetSelection | null }>
  memories(status: MemoryStatus): Promise<{ memories: FleetBotMemory[] }>
  patchMemory(id: string, patch: FleetBotMemoryPatchRequest): Promise<FleetBotMemory>
  deleteMemory(id: string): Promise<void>
  /** A page of the transcript; `reasoning` items only when the reader asked for them. */
  transcript(before: string | null, limit: number, reasoning: boolean): Promise<FleetTranscriptPage>
  image(imageId: string): Promise<{ mediaType: string; bytes: Uint8Array }>
  fileMeta(fileId: string): Promise<FleetFileRef>
  file(fileId: string): Promise<InstanceFile>
  input(value: FleetInstanceInput): Promise<FleetInputReceipt>
  deleteInput(id: string): Promise<void>
  cancel(): Promise<void>
  resolve(id: string, value: FleetInteractionResolution): Promise<void>
  hold(reason: 'takeover' | 'paused'): Promise<FleetInstanceHold>
  release(value: FleetInstanceReleaseRequest): Promise<FleetInstanceHold>
  conversationCall(value: FleetConversationCallRequest): Promise<{ result: unknown }>
}

/** The environment behind the control API: its provisioning, its bots and its screens. */
export interface InstanceEnvironment {
  readonly settings?: FleetEnvironmentSettingsService
  /** The environment's event stream; each bot event names its bot. */
  readonly events: InstanceEvents
  health(): { ok: true; appVersion: string; protocol: 1; ready: boolean; capabilities: readonly string[] }
  environmentStatus(): Promise<FleetInstanceEnvironmentStatus>
  /** The models of the environment's accounts, freshly read; `current` is null, an environment has no selection. */
  selections(): Promise<{ options: FleetSelectionOption[]; current: null }>
  /** The installed bot, or a NOT_FOUND error. */
  bot(botId: string): InstanceBot
  installBot(value: FleetInstanceBotInstall): Promise<FleetInstanceStatus>
  uninstallBot(botId: string, options: { purge: boolean }): Promise<void>
  /** A VNC server showing a screen surface; the tunnel gives its lease back when it ends or fails. */
  acquireScreen(surface: DisplaySurface, mode: VncMode): Promise<VncLease>
  startLogin(request: FleetLoginStartRequest): Promise<FleetLoginAttempt>
  login(loginId: string): FleetLoginAttempt
  loginCallback(loginId: string, request: FleetLoginCallbackRequest): Promise<FleetLoginCallbackResponse>
  submitLoginCode(loginId: string, code: string): Promise<FleetLoginAttempt>
  cancelLogin(loginId: string): Promise<void>
  accounts(): FleetBotAccounts
  importAccounts(request: FleetAccountImportRequest): Promise<FleetImportResults>
  removeSubscription(kind: FleetSubscriptionKind, slot: string): Promise<void>
  skills(): Promise<FleetBotSkills>
  installSkill(request: FleetSkillInstallRequest): Promise<FleetSkillInstallResponse>
  removeSkill(name: string): Promise<void>
  mcpServers(): FleetBotMcpServers
  importMcpServers(request: FleetMcpImportRequest): Promise<FleetImportResults>
  removeMcpServer(id: string): Promise<void>
  addApiKeyAccount(value: FleetAddApiKeyAccountRequest): Promise<FleetAddApiKeyAccountResponse>
  removeAccount(providerId: string): Promise<void>
  open(target: FleetUiOpenRequest['target']): Promise<void>
  /** Starts checks for Claude Code and Codex releases in the background; their results arrive in bot statuses. */
  checkRuntimes(): void
}

// `botId` defaults to null when the event is parsed: events of the environment itself name no bot.
type EventPayload = {
  [K in FleetInstanceEvent['type']]: Omit<Extract<FleetInstanceEvent, { type: K }>, 'seq' | 'at' | 'botId'> & {
    botId?: string | null
  }
}[FleetInstanceEvent['type']]
export class InstanceEvents {
  private seq = 0
  private ring: FleetInstanceEvent[] = []
  private subscribers = new Set<(event: FleetInstanceEvent) => void>()
  get lastSeq(): number {
    return this.seq
  }
  publish(event: EventPayload): FleetInstanceEvent {
    const seq = this.seq + 1
    const payload = event.type === 'status' ? { ...event, status: { ...event.status, lastEventSeq: seq } } : event
    const full = fleetInstanceEventSchema.parse({ ...payload, seq, at: new Date().toISOString() })
    this.seq = seq
    this.ring.push(full)
    if (this.ring.length > 2_000) this.ring.shift()
    for (const send of this.subscribers) send(full)
    return full
  }
  replay(since: number): FleetInstanceEvent[] | null {
    if (since < 0 || !Number.isSafeInteger(since) || since > this.seq) return null
    if (this.ring.length && since < this.ring[0].seq - 1) return null
    return this.ring.filter((event) => event.seq > since)
  }
  subscribe(send: (event: FleetInstanceEvent) => void): () => void {
    this.subscribers.add(send)
    return () => {
      this.subscribers.delete(send)
    }
  }
}
const errorStatus = (status: number): string =>
  (
    ({
      400: 'INVALID_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      426: 'PROTOCOL_INCOMPATIBLE',
    }) as Record<number, string>
  )[status] ?? 'INTERNAL'
function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
const hash = (value: string): Buffer => createHash('sha256').update(value).digest()
function authorized(input: string | undefined, expected: string): boolean {
  if (!input?.startsWith('Bearer ')) return false
  return timingSafeEqual(hash(input.slice(7)), hash(expected))
}
const DEFAULT_BODY_MAX = 1_048_576
async function body(request: IncomingMessage, schema: z.ZodType | null, maxBytes: number): Promise<unknown> {
  if (schema && !request.headers['content-type']?.startsWith('application/json'))
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Expected a JSON request body.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Request body too large.')
    chunks.push(bytes)
  }
  if (!schema) return undefined
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  } catch (error) {
    if (error instanceof InstanceHttpError) throw error
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid request body.')
  }
}

type RouteKey = keyof typeof FLEET_INSTANCE_ROUTES
/** Routes whose bodies may be larger than 1 MiB: a skill's files, and a message's images. */
const BODY_LIMITS: Partial<Record<RouteKey, number>> = {
  skillInstall: FLEET_SKILL_BODY_MAX,
  botInputSend: FLEET_MESSAGE_BODY_MAX,
}
/** Screen routes answer only an upgrade to the screen protocol. */
const SCREEN_ROUTES: ReadonlySet<RouteKey> = new Set<RouteKey>([
  'botScreenView',
  'botScreenControl',
  'environmentScreenView',
  'environmentScreenControl',
])
/** Bot routes that also serve a bot that is not installed: installing it, and uninstalling it again. */
const WITHOUT_INSTALLED_BOT: ReadonlySet<RouteKey> = new Set<RouteKey>(['botInstall', 'botUninstall'])
const COMPILED_ROUTES = (Object.keys(FLEET_INSTANCE_ROUTES) as RouteKey[]).map((key) => {
  const route = FLEET_INSTANCE_ROUTES[key]
  const names: string[] = []
  const pattern = route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    names.push(name)
    return '([^/]+)'
  })
  return { key, method: route.method as string, pattern: new RegExp('^' + pattern + '$'), names }
})
/** The route of a request with its decoded parameters, or null when none matches or a parameter is malformed. */
function routeFor(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | null {
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) continue
    const match = route.pattern.exec(pathname)
    if (!match) continue
    const params: Record<string, string> = {}
    try {
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1])
      })
    } catch {
      return null
    }
    return { key: route.key, params }
  }
  return null
}
const isBotId = (value: string | undefined): value is string =>
  value !== undefined && fleetBotIdSchema.safeParse(value).success
const botNotFound = (): InstanceHttpError => new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
const fileIdOf = (value: string): string => {
  const parsed = fleetFileIdSchema.safeParse(value)
  if (!parsed.success) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid file id.')
  return parsed.data
}
const underTakeover = (bot: InstanceBot): boolean => {
  const hold = bot.holdManager.state
  return hold.state === 'held' && hold.reason === 'takeover'
}
/** The surface and mode a screen upgrade asks for, or null for a path that is not a screen. */
function screenFor(pathname: string): { surface: DisplaySurface; mode: VncMode } | null {
  const match = routeFor('GET', pathname)
  if (!match) return null
  if (match.key === 'environmentScreenView' || match.key === 'environmentScreenControl')
    return { surface: { kind: 'environment' }, mode: match.key === 'environmentScreenView' ? 'view' : 'control' }
  if (match.key !== 'botScreenView' && match.key !== 'botScreenControl') return null
  const kind = fleetScreenSurfaceSchema.safeParse(match.params.surface)
  if (!kind.success || !isBotId(match.params.botId)) return null
  return {
    surface: { kind: kind.data, botId: match.params.botId },
    mode: match.key === 'botScreenView' ? 'view' : 'control',
  }
}
function parsePurge(url: URL): boolean {
  const raw = url.searchParams.get('purge')
  if (raw === null || raw === '0' || raw === 'false') return false
  if (raw === '1' || raw === 'true') return true
  throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid purge flag.')
}
function sseFrame(event: FleetInstanceEvent): string {
  return `id: ${event.seq}\nevent: fleet\ndata: ${JSON.stringify(event)}\n\n`
}
function streamEvents(request: IncomingMessage, response: ServerResponse, url: URL, events: InstanceEvents): void {
  const raw = url.searchParams.get('since') ?? '0'
  if (!/^\d+$/.test(raw)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid event cursor.')
  const since = Number(raw)
  if (!Number.isSafeInteger(since)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid event cursor.')
  // A gateway that does not read `reasoning` items never gets them: it would fail on the whole stream.
  const reasoning = fleetReaderWantsReasoning(url.searchParams)
  const readable = (event: FleetInstanceEvent) =>
    event.type !== 'transcript.upsert' || fleetTranscriptItemReadable(event.item, reasoning)
  const replay = events.replay(since)
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  if (replay === null)
    response.write(sseFrame({ seq: events.lastSeq, at: new Date().toISOString(), type: 'reset', botId: null }))
  else for (const event of replay) if (readable(event)) response.write(sseFrame(event))
  const unsubscribe = events.subscribe((event) => {
    if (readable(event)) response.write(sseFrame(event))
  })
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15_000)
  request.on('close', () => {
    unsubscribe()
    clearInterval(heartbeat)
  })
}

const VIEWERS_MAX = 4
const CONTROLLERS_MAX = 1

/** A screen connection: reserved when it is accepted, open once upgraded, and ended at most once. */
interface Tunnel {
  /** What it shows: `environment`, or `browser:<botId>` and `apps:<botId>`. */
  readonly surface: string
  readonly mode: VncMode
  readonly botId: string | null
  /** The bot's slot when it was accepted: a bot that moves to another slot moves its screens. */
  readonly slot: number | null
  /** A control of the environment display :0, which the environment screen and every bot's browser share. */
  readonly zero: boolean
  readonly socket: Duplex
  lease: VncLease | null
  vnc: Socket | null
  ended: boolean
}

type Handler = (request: { params: Record<string, string>; url: URL; input: unknown }) => unknown

/**
 * The control API of an environment instance. Environment routes (health, status, provisioning, the environment
 * screen and the event stream) live at `/v1/…`; each bot's routes and screens live under `/v1/bots/:botId/…`.
 *
 * Screens: every surface takes four viewers and one controller. The environment screen and the bots' browser areas
 * share the pointer and keyboard of the environment display, so only one of them is controlled at a time; each bot's
 * apps display is separate. A bot's screens need that bot's takeover for control, and its controls end when its
 * takeover does; the environment screen needs none.
 */
export function createInstanceControlServer(config: BotInstanceConfig, environment: InstanceEnvironment): http.Server {
  function settings(): FleetEnvironmentSettingsService {
    if (!environment.settings)
      throw new InstanceHttpError(409, 'CONFLICT', 'Environment settings are unavailable. Restart to update.')
    return environment.settings
  }
  const tunnels = new Set<Tunnel>()
  const end = (tunnel: Tunnel): void => {
    if (tunnel.ended) return
    tunnel.ended = true
    tunnels.delete(tunnel)
    tunnel.lease?.release()
    tunnel.vnc?.destroy()
    tunnel.socket.destroy()
  }
  const endWhere = (test: (tunnel: Tunnel) => boolean): void => {
    for (const tunnel of [...tunnels]) if (test(tunnel)) end(tunnel)
  }
  /** Ends the controls of a bot that is not under takeover any more; viewers and other bots' screens stay. */
  const endControlsWithoutTakeover = (botId: string): void => {
    let bot: InstanceBot | null
    try {
      bot = environment.bot(botId)
    } catch {
      bot = null
    }
    if (bot && underTakeover(bot)) return
    endWhere((tunnel) => tunnel.botId === botId && tunnel.mode === 'control')
  }
  const bot = (params: Record<string, string>): InstanceBot => {
    if (!isBotId(params.botId)) throw botNotFound()
    return environment.bot(params.botId)
  }

  const handlers: Partial<Record<RouteKey, Handler>> = {
    settingsAccounts: () => settings().accounts(FLEET_SETTINGS_OPERATIONS.accounts.input.parse({})),
    settingsPatchAccount: ({ input }) =>
      settings().patchAccount(FLEET_SETTINGS_OPERATIONS.patchAccount.input.parse(input)),
    settingsRenameSubscription: ({ input }) =>
      settings().renameSubscription(FLEET_SETTINGS_OPERATIONS.renameSubscription.input.parse(input)),
    settingsRemoveAccount: ({ input }) =>
      settings().removeAccount(FLEET_SETTINGS_OPERATIONS.removeAccount.input.parse(input)),
    settingsRemoveSubscription: ({ input }) =>
      settings().removeSubscription(FLEET_SETTINGS_OPERATIONS.removeSubscription.input.parse(input)),
    settingsModels: () => settings().models(FLEET_SETTINGS_OPERATIONS.models.input.parse({})),
    settingsSetModelFilter: ({ input }) =>
      settings().setModelFilter(FLEET_SETTINGS_OPERATIONS.setModelFilter.input.parse(input)),
    settingsSkills: () => settings().skills(FLEET_SETTINGS_OPERATIONS.skills.input.parse({})),
    settingsSkill: ({ params }) => settings().skill(FLEET_SETTINGS_OPERATIONS.skill.input.parse({ name: params.name })),
    settingsCreateSkill: ({ input }) =>
      settings().createSkill(FLEET_SETTINGS_OPERATIONS.createSkill.input.parse(input)),
    settingsWriteSkill: ({ input }) => settings().writeSkill(FLEET_SETTINGS_OPERATIONS.writeSkill.input.parse(input)),
    settingsSetSkillEnabled: ({ input }) =>
      settings().setSkillEnabled(FLEET_SETTINGS_OPERATIONS.setSkillEnabled.input.parse(input)),
    settingsRemoveSkill: ({ input }) =>
      settings().removeSkill(FLEET_SETTINGS_OPERATIONS.removeSkill.input.parse(input)),
    settingsSearchSkills: ({ input }) =>
      settings().searchSkills(FLEET_SETTINGS_OPERATIONS.searchSkills.input.parse(input)),
    settingsInstallSkill: ({ input }) =>
      settings().installSkill(FLEET_SETTINGS_OPERATIONS.installSkill.input.parse(input)),
    settingsSkillGroups: () => settings().skillGroups(FLEET_SETTINGS_OPERATIONS.skillGroups.input.parse({})),
    settingsCreateSkillGroup: ({ input }) =>
      settings().createSkillGroup(FLEET_SETTINGS_OPERATIONS.createSkillGroup.input.parse(input)),
    settingsUpdateSkillGroup: ({ input }) =>
      settings().updateSkillGroup(FLEET_SETTINGS_OPERATIONS.updateSkillGroup.input.parse(input)),
    settingsRemoveSkillGroup: ({ input }) =>
      settings().removeSkillGroup(FLEET_SETTINGS_OPERATIONS.removeSkillGroup.input.parse(input)),
    settingsMcpServers: () => settings().mcpServers(FLEET_SETTINGS_OPERATIONS.mcpServers.input.parse({})),
    settingsMcpServer: ({ params }) =>
      settings().mcpServer(FLEET_SETTINGS_OPERATIONS.mcpServer.input.parse({ id: params.id })),
    settingsCreateMcpServer: ({ input }) =>
      settings().createMcpServer(FLEET_SETTINGS_OPERATIONS.createMcpServer.input.parse(input)),
    settingsPatchMcpServer: ({ input }) =>
      settings().patchMcpServer(FLEET_SETTINGS_OPERATIONS.patchMcpServer.input.parse(input)),
    settingsRemoveMcpServer: ({ input }) =>
      settings().removeMcpServer(FLEET_SETTINGS_OPERATIONS.removeMcpServer.input.parse(input)),
    settingsTestMcpServer: ({ input }) =>
      settings().testMcpServer(FLEET_SETTINGS_OPERATIONS.testMcpServer.input.parse(input)),
    settingsRuntimes: () => settings().runtimes(FLEET_SETTINGS_OPERATIONS.runtimes.input.parse({})),
    settingsRuntimeAction: ({ input }) =>
      settings().runtimeAction(FLEET_SETTINGS_OPERATIONS.runtimeAction.input.parse(input)),
    settingsSetRuntimeAutomatic: ({ input }) =>
      settings().setRuntimeAutomatic(FLEET_SETTINGS_OPERATIONS.setRuntimeAutomatic.input.parse(input)),
    settingsPreferences: () => settings().preferences(FLEET_SETTINGS_OPERATIONS.preferences.input.parse({})),
    settingsSetPreferences: ({ input }) =>
      settings().setPreferences(FLEET_SETTINGS_OPERATIONS.setPreferences.input.parse(input)),
    health: () => environment.health(),
    environmentStatus: () => environment.environmentStatus(),
    runtimesCheck: () => {
      environment.checkRuntimes()
      return { ok: true as const }
    },
    environmentSelections: () => environment.selections(),
    loginStart: ({ input }) => environment.startLogin(input as FleetLoginStartRequest),
    loginGet: ({ params }) => environment.login(params.lid),
    loginCallback: ({ params, input }) => environment.loginCallback(params.lid, input as FleetLoginCallbackRequest),
    loginCode: ({ params, input }) => environment.submitLoginCode(params.lid, (input as { code: string }).code),
    loginCancel: ({ params }) => environment.cancelLogin(params.lid),
    accountsList: () => environment.accounts(),
    accountsImport: ({ input }) => environment.importAccounts(input as FleetAccountImportRequest),
    subscriptionRemove: ({ params }) => {
      const kind = fleetSubscriptionKindSchema.safeParse(params.kind)
      const slot = params.slot === 'default' ? params.slot : fleetAccountSlotIdSchema.safeParse(params.slot).data
      if (!kind.success || !slot) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid subscription slot.')
      return environment.removeSubscription(kind.data, slot)
    },
    skillsList: () => environment.skills(),
    skillInstall: ({ input }) => environment.installSkill(input as FleetSkillInstallRequest),
    skillRemove: ({ params }) => environment.removeSkill(params.name),
    mcpServersList: () => environment.mcpServers(),
    mcpServersImport: ({ input }) => environment.importMcpServers(input as FleetMcpImportRequest),
    mcpServerRemove: ({ params }) => environment.removeMcpServer(params.sid),
    apiKeyAccountAdd: ({ input }) => environment.addApiKeyAccount(input as FleetAddApiKeyAccountRequest),
    accountRemove: ({ params }) => environment.removeAccount(params.providerId),
    uiOpen: ({ input }) => environment.open((input as FleetUiOpenRequest).target),

    botInstall: async ({ params, input }) => {
      const value = input as FleetInstanceBotInstall
      if (value.profile.botId !== params.botId)
        throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The profile belongs to another bot.')
      const status = await environment.installBot(value)
      // A bot that moved to another slot shows other screens now: the tunnels to its former ones end.
      endWhere((tunnel) => tunnel.botId === params.botId && tunnel.slot !== value.slot)
      return status
    },
    botUninstall: async ({ params, url }) => {
      const purge = parsePurge(url)
      try {
        await environment.uninstallBot(params.botId, { purge })
      } finally {
        endWhere((tunnel) => tunnel.botId === params.botId)
      }
    },
    botStatus: ({ params }) => bot(params).status(),
    botSelections: ({ params }) => bot(params).selections(),
    botMemoriesList: ({ params, url }) => {
      const status = url.searchParams.get('status') ?? 'active'
      if (!MEMORY_STATUSES.includes(status))
        throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid memory status.')
      return bot(params).memories(status as MemoryStatus)
    },
    botMemoryPatch: ({ params, input }) => bot(params).patchMemory(params.id, input as FleetBotMemoryPatchRequest),
    botMemoryDelete: ({ params }) => bot(params).deleteMemory(params.id),
    botTranscript: ({ params, url }) => {
      const raw = url.searchParams.get('limit')
      const limit = raw === null ? 200 : Number(raw)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid transcript limit.')
      return bot(params).transcript(url.searchParams.get('before'), limit, fleetReaderWantsReasoning(url.searchParams))
    },
    botImage: ({ params }) => bot(params).image(params.imageId),
    botFileMeta: ({ params }) => bot(params).fileMeta(fileIdOf(params.fileId)),
    botFile: ({ params }) => bot(params).file(fileIdOf(params.fileId)),
    botInputSend: ({ params, input }) => bot(params).input(input as FleetInstanceInput),
    botInputDelete: ({ params }) => bot(params).deleteInput(params.inputId),
    botTurnCancel: ({ params }) => bot(params).cancel(),
    botInteractionResolve: ({ params, input }) => bot(params).resolve(params.id, input as FleetInteractionResolution),
    botHold: async ({ params, input }) => {
      const hold = await bot(params).hold((input as { reason: 'takeover' | 'paused' }).reason)
      endControlsWithoutTakeover(params.botId)
      return hold
    },
    botHoldRelease: async ({ params, input }) => {
      const hold = await bot(params).release(input as FleetInstanceReleaseRequest)
      endControlsWithoutTakeover(params.botId)
      return hold
    },
    botConversationCall: ({ params, input }) => bot(params).conversationCall(input as FleetConversationCallRequest),
  }

  const server = http.createServer(async (request, response) => {
    try {
      if ('origin' in request.headers) throw new InstanceHttpError(403, 'FORBIDDEN', 'Origin requests are forbidden.')
      if (request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
        throw new InstanceHttpError(426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
      if (!authorized(request.headers.authorization, config.controlToken))
        throw new InstanceHttpError(401, 'UNAUTHORIZED', 'Invalid control credentials.')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const match = routeFor(request.method ?? '', url.pathname)
      if (!match) throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
      if (SCREEN_ROUTES.has(match.key)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Screen upgrade required.')
      if (match.key === 'events') return streamEvents(request, response, url, environment.events)
      // Routes of an instance that hosted a single bot, such as `/v1/status`, are gone: bots are addressed by id.
      const handler = handlers[match.key]
      if (!handler) throw new InstanceHttpError(404, 'NOT_FOUND', 'Route not found.')
      if ('botId' in match.params) {
        if (!isBotId(match.params.botId)) throw botNotFound()
        // An unknown bot is refused before its body is read.
        if (!WITHOUT_INSTALLED_BOT.has(match.key)) environment.bot(match.params.botId)
      }
      const route = FLEET_INSTANCE_ROUTES[match.key]
      const input = await body(request, route.body, BODY_LIMITS[match.key] ?? DEFAULT_BODY_MAX)
      if (match.key.startsWith('settings') && input && typeof input === 'object') {
        for (const [key, value] of Object.entries(match.params)) {
          const supplied = Reflect.get(input, key)
          if ((supplied === null && key === 'slot' ? 'default' : supplied) !== value)
            throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Path and settings identifiers differ.')
        }
      }
      const output = await handler({ params: match.params, url, input })
      if (match.key === 'botFile') {
        const file = output as InstanceFile
        try {
          const ref = fleetFileRefSchema.parse(file.ref)
          response.writeHead(200, {
            'Content-Type': ref.mediaType,
            'Content-Length': ref.byteSize,
            'Content-Disposition':
              "attachment; filename*=UTF-8''" +
              encodeURIComponent(ref.name).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16)),
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          let size = 0
          const bounded = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              size += chunk.length
              callback(size > ref.byteSize ? new Error('File exceeds its recorded size') : null, chunk)
            },
            flush(callback) {
              callback(size === ref.byteSize ? null : new Error('Incomplete file'))
            },
          })
          await pipeline(file.stream, bounded, response)
        } finally {
          file.stream.destroy()
        }
        return
      }
      if (match.key === 'botImage') {
        const image = output as { mediaType: string; bytes: Uint8Array }
        response.writeHead(200, {
          'Content-Type': image.mediaType,
          'Content-Length': image.bytes.length,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(Buffer.from(image.bytes))
        return
      }
      if (route.response) writeJson(response, 200, route.response.parse(output))
      else {
        response.writeHead(204)
        response.end()
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy()
        return
      }
      const known =
        error instanceof InstanceHttpError ? error : new InstanceHttpError(500, 'INTERNAL', 'Instance request failed.')
      writeJson(response, known.status, { code: known.code || errorStatus(known.status), message: known.message })
    }
  })

  // A status of a bot whose takeover ended closes that bot's controls, and only its own. The status is only a
  // signal: the bot's current hold decides, so a late status never ends a control that a new takeover allows.
  const stopWatching = environment.events.subscribe((event) => {
    if (event.type === 'status' && event.botId) endControlsWithoutTakeover(event.botId)
  })
  const originalClose = server.close.bind(server)
  server.close = ((callback?: (error?: Error) => void) => {
    stopWatching()
    endWhere(() => true)
    return originalClose(callback)
  }) as typeof server.close

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined)
    const reject = (status: number, code: string, message: string): void => {
      if (socket.destroyed) return
      const text = JSON.stringify({ code, message })
      socket.end(
        `HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
      )
    }
    let tunnel: Tunnel | null = null
    // Gives back what an accepted tunnel holds, then answers; a tunnel that already ended has no one to answer.
    const fail = (status: number, code: string, message: string): void => {
      if (tunnel) {
        if (tunnel.ended) return
        tunnel.ended = true
        tunnels.delete(tunnel)
        tunnel.lease?.release()
        tunnel.vnc?.destroy()
      }
      reject(status, code, message)
    }
    void (async () => {
      if ('origin' in request.headers) return fail(403, 'FORBIDDEN', 'Origin requests are forbidden.')
      if (request.headers[FLEET_PROTOCOL_HEADER.toLowerCase()] !== String(FLEET_PROTOCOL_VERSION))
        return fail(426, 'PROTOCOL_INCOMPATIBLE', 'Incompatible fleet protocol.')
      if (!authorized(request.headers.authorization, config.controlToken))
        return fail(401, 'UNAUTHORIZED', 'Invalid control credentials.')
      const url = new URL(request.url ?? '/', 'http://localhost')
      const screen = request.method === 'GET' ? screenFor(url.pathname) : null
      if (!screen) return fail(404, 'NOT_FOUND', 'Route not found.')
      if (
        !request.headers.connection
          ?.toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .includes('upgrade') ||
        request.headers.upgrade?.toLowerCase() !== FLEET_SCREEN_UPGRADE
      )
        return fail(400, 'INVALID_REQUEST', 'Screen upgrade required.')
      const { surface, mode } = screen
      const owner = surface.kind === 'environment' ? null : environment.bot(surface.botId)
      if (owner && mode === 'control' && !underTakeover(owner)) return fail(409, 'CONFLICT', 'Takeover hold required.')

      // Accepted before anything asynchronous happens, so two requests can never both pass the limits.
      const key = surface.kind === 'environment' ? 'environment' : `${surface.kind}:${surface.botId}`
      const zero = mode === 'control' && surface.kind !== 'apps'
      const open = [...tunnels]
      if (
        open.filter((entry) => entry.surface === key && entry.mode === mode).length >=
        (mode === 'view' ? VIEWERS_MAX : CONTROLLERS_MAX)
      )
        return fail(409, 'CONFLICT', 'Screen tunnel limit reached.')
      if (zero && open.some((entry) => entry.zero))
        return fail(409, 'CONFLICT', 'Another screen of this environment is being controlled.')
      const entry: Tunnel = {
        surface: key,
        mode,
        botId: owner?.botId ?? null,
        slot: owner?.slot ?? null,
        zero,
        socket,
        lease: null,
        vnc: null,
        ended: false,
      }
      tunnel = entry
      tunnels.add(entry)
      // The server keeps sockets half-open: a client that leaves only ends its side, and it has left all the same.
      socket.once('end', () => end(entry))
      socket.once('close', () => end(entry))

      let lease: VncLease
      try {
        lease = await environment.acquireScreen(surface, mode)
      } catch (error) {
        if (error instanceof InstanceHttpError) throw error
        throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Screen unavailable.')
      }
      if (entry.ended) return lease.release()
      entry.lease = lease
      const vnc = createConnection({ host: '127.0.0.1', port: lease.port })
      entry.vnc = vnc
      await new Promise<void>((resolve, rejectConnection) => {
        vnc.once('connect', resolve)
        vnc.once('error', rejectConnection)
        vnc.once('close', () => rejectConnection(new Error('The VNC connection closed.')))
      }).catch(() => {
        throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Screen unavailable.')
      })
      if (entry.ended) return
      if (socket.destroyed) return end(entry)
      if (owner) {
        // The bot may have been uninstalled, or its takeover released, while its screen connected.
        let current: InstanceBot | null
        try {
          current = environment.bot(owner.botId)
        } catch {
          current = null
        }
        if (current !== owner) return fail(404, 'NOT_FOUND', 'Bot does not exist.')
        if (mode === 'control' && !underTakeover(owner)) return fail(409, 'CONFLICT', 'Takeover hold required.')
      }
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${FLEET_SCREEN_UPGRADE}\r\n\r\n`
      )
      vnc.on('close', () => end(entry))
      vnc.on('error', () => end(entry))
      if (head.length && !vnc.write(head)) socket.pause()
      socket.pipe(vnc).pipe(socket)
    })().catch((error: unknown) => {
      const known =
        error instanceof InstanceHttpError ? error : new InstanceHttpError(500, 'INTERNAL', 'Screen request failed.')
      fail(known.status, known.code, known.message)
    })
  })
  return server
}
