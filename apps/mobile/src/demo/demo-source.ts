import {
  compareFleetTranscriptItems,
  deriveBotId,
  FLEET_DEVICES_FEATURE,
  FLEET_PHONES_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_FILES_FEATURE,
  FLEET_GATEWAY_ROUTES,
  FLEET_PEER_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_TRANSCRIPT_REASONING_FEATURE,
  summarizeText,
  type FleetBot,
  type FleetCreateBotRequest,
  type FleetDevice,
  type FleetGatewayEvent,
  type FleetInboxItem,
  type FleetInteractionResolution,
  type FleetPatchBotRequest,
  type FleetSendMessageRequest,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError, type CallOptions, type GatewayClient, type RouteKey } from '../gateway/client'
import { joinAvailability } from '../fleet/create-bot'
import { botRecord } from '../fleet/factories'
import type { EventHandlers, FleetSource } from '../fleet/source'
import type { PairedServer } from '../servers/registry'
import { createDemoLanes, DEMO_LANES_BOT, demoLaneWorld } from './demo-lanes'
import { DEMO_OPTIONS, DEMO_SCRIPTS, demoWorld, pixelAnswered, REPLY_SCRIPT, type AskSpec, type Step } from './fixtures'

export const DEMO_FEATURES = [
  FLEET_FILES_FEATURE,
  FLEET_ENVIRONMENTS_FEATURE,
  FLEET_TRANSCRIPT_REASONING_FEATURE,
  FLEET_PHONES_FEATURE,
  FLEET_DEVICES_FEATURE,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_PEER_CONVERSATIONS_FEATURE,
]

/** The demo server as a paired server: it never leaves the phone. */
export const DEMO_SERVER: PairedServer = {
  id: 'demo',
  origin: 'https://demo.maestrly.invalid',
  name: 'demo',
  deviceName: 'Phone',
  features: DEMO_FEATURES,
  pairedAt: '2026-10-12T12:00:00.000Z',
}

const PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN89+7dfwAJYAPdTr4y2gAAAABJRU5ErkJggg=='

type Pending = { botId: string; spec: AskSpec }

/**
 * A bot server that lives in memory, with the prototype's bots and scripted replies. It answers the same routes and
 * sends the same events as a gateway, so every screen can be used without one: in development, in the web preview
 * (whose browser requests the gateway would refuse for their Origin header), and later for App Store review.
 */
export function createDemoSource(options: { stepMs?: number; autoplay?: boolean } = {}): FleetSource {
  const scale = (options.stepMs ?? 1000) / 1000
  const world = demoWorld(Date.now())
  const order = world.bots.map((bot) => bot.id)
  // Made-up devices paired with the demo server; this phone is the one it knows as `DEMO_SERVER.id`.
  let devices: FleetDevice[] = [
    {
      id: 'demo-mac',
      name: 'MacBook Pro',
      kind: 'computer',
      platform: 'macos',
      pairedAt: '2026-09-02T14:10:00.000Z',
      lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      current: false,
      notifications: false,
    },
    {
      id: DEMO_SERVER.id,
      name: 'Phone',
      kind: 'phone',
      platform: 'ios',
      pairedAt: '2026-10-12T12:00:00.000Z',
      lastSeenAt: new Date().toISOString(),
      current: true,
      notifications: true,
    },
    {
      id: 'demo-pixel',
      name: 'Pixel 9',
      kind: 'phone',
      platform: 'android',
      pairedAt: '2026-09-20T09:30:00.000Z',
      lastSeenAt: '2026-10-01T18:45:00.000Z',
      current: false,
      notifications: true,
    },
  ]
  // Atlas keeps its routine runs and its conversations with other bots apart, as current bots do.
  const laneWorld = demoLaneWorld(Date.now())
  for (const bot of world.bots)
    if (bot.id === DEMO_LANES_BOT)
      bot.capabilities = [...bot.capabilities, FLEET_ROUTINE_CONVERSATIONS_FEATURE, FLEET_PEER_CONVERSATIONS_FEATURE]
  world.transcripts[DEMO_LANES_BOT] = [...laneWorld.conversation, ...world.transcripts[DEMO_LANES_BOT]].sort(
    compareFleetTranscriptItems
  )
  const bots = new Map(world.bots.map((bot) => [bot.id, bot]))
  const transcripts = world.transcripts
  const routines = world.routines
  const listeners = new Set<EventHandlers>()
  const pending = new Map<string, Pending>()
  const receipts = new Map<string, { hash: string; receipt: { inputId: string; itemId: string; queued: boolean } }>()
  const createdBots = new Map<string, string>()
  const runs = new Map<string, number>()
  const queue = new Map<string, string[]>()
  let inbox: FleetInboxItem[] = []
  let seq = 0
  let clock = Date.now()
  let autoplayed = false

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms * scale))
  const stamp = () => {
    clock = Math.max(clock + 1, Date.now())
    return new Date(clock).toISOString()
  }
  const nextId = (botId: string) => `${botId}-x${++seq}`
  const emit = (event: FleetGatewayEvent) => {
    for (const listener of listeners) listener.onEvent(event)
  }
  const requireBot = (id: string): FleetBot => {
    const bot = bots.get(id)
    if (!bot) throw new GatewayError('NOT_FOUND', 404, 'Bot not found')
    return bot
  }
  const updateBot = (id: string, patch: Partial<FleetBot>): FleetBot => {
    const at = stamp()
    const next = { ...requireBot(id), ...patch, updatedAt: at }
    bots.set(id, next)
    emit({ type: 'bot.updated', at, bot: next })
    return next
  }
  const upsert = (botId: string, item: FleetTranscriptItem) => {
    const list = transcripts[botId]
    const at = list.findIndex((existing) => existing.id === item.id)
    if (at < 0) list.push(item)
    else list[at] = item
    list.sort(compareFleetTranscriptItems)
    emit({ type: 'transcript.upsert', at: stamp(), botId, item })
  }
  const system = (botId: string, code: Extract<FleetTranscriptItem, { kind: 'system' }>['code']) =>
    upsert(botId, { id: nextId(botId), at: stamp(), kind: 'system', code, text: null, durationMs: null })
  const setInbox = (items: FleetInboxItem[]) => {
    inbox = items
    emit({ type: 'inbox.updated', at: stamp(), items })
  }
  // Atlas's routine runs and conversations with other bots, apart from its own conversation.
  const lanes = createDemoLanes(laneWorld, { emit, stamp, nextId, sleep, requireBot, updateBot })

  // The prototype's two waiting bots start with their requests open.
  for (const item of [...transcripts.atlas, ...transcripts.pixel]) {
    if (item.kind === 'permission' && item.state === 'pending') {
      pending.set(item.requestId, {
        botId: 'atlas',
        spec: {
          kind: 'permission',
          title: item.title,
          detail: item.detail,
          tool: { name: 'bash', target: item.tool?.target ?? '' },
          next: { allow: 'atlasDeploy', deny: 'atlasDenied' },
        },
      })
      inbox.push({
        botId: 'atlas',
        interaction: {
          kind: 'permission',
          id: item.requestId,
          at: item.at,
          title: item.title,
          detail: item.detail,
          tool: item.tool,
          itemId: item.id,
        },
      })
    }
    if (item.kind === 'question' && item.state === 'pending') {
      pending.set(item.toolCallId, {
        botId: 'pixel',
        spec: { kind: 'question', questions: item.questions, next: pixelAnswered },
      })
      inbox.push({
        botId: 'pixel',
        interaction: { kind: 'question', id: item.toolCallId, at: item.at, questions: item.questions, itemId: item.id },
      })
    }
  }

  const isRunning = (botId: string) => bots.get(botId)?.status === 'working'
  const busy = (botId: string) => ['working', 'waiting', 'paused'].includes(requireBot(botId).status)

  function finish(botId: string, summary: string | null) {
    updateBot(botId, {
      status: 'idle',
      pendingCount: 0,
      activity: { kind: 'idle', lastTurnSummary: summary, lastTurnAt: stamp() },
    })
    drain(botId)
  }

  /** The next queued message reaches the bot once it is free: it moves to the end of the conversation. */
  function drain(botId: string) {
    const waiting = queue.get(botId) ?? []
    const next = waiting.shift()
    if (!next || busy(botId)) {
      if (next) waiting.unshift(next)
      return
    }
    const item = transcripts[botId].find((existing) => existing.id === next)
    if (item?.kind !== 'user') return
    upsert(botId, { ...item, at: stamp(), queued: false })
    void run(botId, DEMO_SCRIPTS[item.source === 'routine' ? 'routine' : (REPLY_SCRIPT[botId] ?? 'scoutReply')])
  }

  async function stream(botId: string, text: string, alive: () => boolean) {
    const item = { id: nextId(botId), at: stamp(), kind: 'assistant' as const, text: '', streaming: true }
    const words = text.match(/\s*\S+/g) ?? []
    for (let at = 0; at < words.length && alive(); at += 3) {
      item.text += words.slice(at, at + 3).join('')
      upsert(botId, { ...item })
      await sleep(45)
    }
    // A cancelled turn keeps only what it had said.
    upsert(botId, { ...item, text: alive() ? text : item.text, streaming: false })
  }

  function ask(botId: string, spec: AskSpec) {
    const id = nextId(botId)
    const itemId = nextId(botId)
    const at = stamp()
    pending.set(id, { botId, spec })
    if (spec.kind === 'permission') {
      upsert(botId, {
        id: itemId,
        at,
        kind: 'permission',
        requestId: id,
        title: spec.title,
        detail: spec.detail,
        tool: spec.tool,
        state: 'pending',
        resolvedAt: null,
      })
      setInbox([
        ...inbox,
        {
          botId,
          interaction: { kind: 'permission', id, at, title: spec.title, detail: spec.detail, tool: spec.tool, itemId },
        },
      ])
      updateBot(botId, { status: 'waiting', pendingCount: 1, activity: { kind: 'permission', title: spec.title } })
    } else if (spec.kind === 'question') {
      upsert(botId, {
        id: itemId,
        at,
        kind: 'question',
        toolCallId: id,
        questions: spec.questions,
        state: 'pending',
        answers: null,
      })
      setInbox([...inbox, { botId, interaction: { kind: 'question', id, at, questions: spec.questions, itemId } }])
      updateBot(botId, { status: 'waiting', pendingCount: 1, activity: { kind: 'question' } })
    } else {
      upsert(botId, {
        id: itemId,
        at,
        kind: 'help',
        helpId: id,
        reason: spec.reason,
        state: 'pending',
        resolvedAt: null,
        note: null,
      })
      setInbox([...inbox, { botId, interaction: { kind: 'help', id, at, reason: spec.reason, itemId } }])
      updateBot(botId, { status: 'waiting', pendingCount: 1, activity: { kind: 'help', reason: spec.reason } })
    }
  }

  async function run(botId: string, steps: Step[]) {
    const token = (runs.get(botId) ?? 0) + 1
    runs.set(botId, token)
    const alive = () => runs.get(botId) === token
    let summary: string | null = null
    let said = ''
    updateBot(botId, { status: 'working', activity: { kind: 'thinking' } })
    for (const step of steps) {
      if (!alive()) return
      if ('think' in step) {
        updateBot(botId, { activity: { kind: 'thinking' } })
        await sleep(step.think)
      } else if ('complete' in step) {
        const tool = [...transcripts[botId]].reverse().find((item) => item.kind === 'tool' && item.state === 'running')
        if (tool?.kind !== 'tool') continue
        updateBot(botId, { activity: { kind: 'tool', tool: tool.name, target: tool.target } })
        await sleep(step.ms ?? 1000)
        if (!alive()) return
        upsert(botId, { ...tool, state: step.fail ? 'error' : 'done', output: step.complete.output })
      } else if ('tool' in step) {
        const tool = {
          id: nextId(botId),
          at: stamp(),
          kind: 'tool' as const,
          name: step.tool.name,
          target: step.tool.target,
          state: 'running' as const,
          output: null,
          images: [],
        }
        upsert(botId, tool)
        updateBot(botId, { activity: { kind: 'tool', tool: tool.name, target: tool.target } })
        await sleep(step.ms ?? 1200)
        if (!alive()) return
        upsert(botId, { ...tool, state: step.fail ? 'error' : 'done', output: step.tool.output ?? null })
      } else if ('todos' in step) {
        const list = transcripts[botId]
        const lastUser = list.map((item) => item.kind === 'user' && !item.queued).lastIndexOf(true)
        const existing = list.slice(lastUser + 1).find((item) => item.kind === 'tool' && item.name === 'todo_write')
        const base = existing?.kind === 'tool' ? existing : null
        upsert(botId, {
          ...(base ?? {
            id: nextId(botId),
            at: stamp(),
            kind: 'tool' as const,
            name: 'todo_write',
            target: null,
            state: 'done' as const,
            output: null,
            images: [],
          }),
          todos: step.todos,
        })
      } else if ('say' in step) {
        await stream(botId, step.say, alive)
        said = step.say
      } else if ('summary' in step) {
        summary = step.summary
      } else if ('ask' in step) {
        ask(botId, step.ask)
        return
      }
    }
    if (alive()) finish(botId, summary ?? (said ? summarizeText(said.replace(/[*`]/g, ''), 120) : null))
  }

  function cancel(botId: string, code: 'turn_cancelled' | null) {
    runs.set(botId, (runs.get(botId) ?? 0) + 1)
    for (const item of transcripts[botId]) {
      if (item.kind === 'tool' && item.state === 'running') upsert(botId, { ...item, state: 'interrupted' })
      if (item.kind === 'assistant' && item.streaming) upsert(botId, { ...item, streaming: false })
    }
    if (code) system(botId, code)
  }

  function resolve(botId: string, interactionId: string, resolution: FleetInteractionResolution) {
    const request = pending.get(interactionId)
    const open = inbox.find((item) => item.botId === botId && item.interaction.id === interactionId)
    if (!request || !open) throw new GatewayError('NOT_FOUND', 404, 'Request not found')
    pending.delete(interactionId)
    const item = transcripts[botId].find((existing) => existing.id === open.interaction.itemId)
    const resolvedAt = stamp()
    let next: Step[] = DEMO_SCRIPTS.scoutReply
    if (item?.kind === 'permission' && request.spec.kind === 'permission' && resolution.kind === 'permission') {
      const allowed = resolution.reply !== 'reject'
      upsert(botId, { ...item, state: allowed ? 'approved' : 'denied', resolvedAt })
      next = DEMO_SCRIPTS[allowed ? request.spec.next.allow : request.spec.next.deny]
    } else if (item?.kind === 'question' && request.spec.kind === 'question') {
      if (resolution.kind === 'question') {
        upsert(botId, { ...item, state: 'answered', answers: resolution.answers })
        next = request.spec.next(resolution.answers.flat().join(', '))
      } else {
        upsert(botId, { ...item, state: 'dismissed' })
        next = DEMO_SCRIPTS.questionDismissed
      }
    } else if (item?.kind === 'help' && request.spec.kind === 'help' && resolution.kind === 'help') {
      upsert(botId, { ...item, state: 'resolved', resolvedAt, note: resolution.note })
      next = DEMO_SCRIPTS[request.spec.next]
    }
    setInbox(inbox.filter((entry) => entry !== open))
    void run(botId, next)
  }

  function send(botId: string, body: FleetSendMessageRequest) {
    const bot = requireBot(botId)
    if (['offline', 'starting', 'setup'].includes(bot.status))
      throw new GatewayError('BOT_NOT_RUNNING', 409, 'Bot not running')
    const hash = JSON.stringify(body)
    const previous = receipts.get(body.idempotencyKey)
    if (previous) {
      if (previous.hash !== hash) throw new GatewayError('CONFLICT', 409, 'Idempotency key used with different request')
      return previous.receipt
    }
    const queued = busy(botId)
    const itemId = nextId(botId)
    const images = body.attachments
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment, index) => ({
        id: `${itemId}-img${index}`,
        mediaType: attachment.mediaType as 'image/png',
        byteSize: null,
        name: attachment.name,
      }))
    const files = body.attachments
      .filter((attachment) => attachment.kind !== 'image')
      .map((attachment, index) => ({
        id: `${itemId}-file${index}`,
        name: attachment.name,
        mediaType: attachment.mediaType,
        byteSize: Math.floor((attachment.dataBase64.length * 3) / 4),
      }))
    const citation = body.citation ? lanes.citation(body.citation.runId) : null
    upsert(botId, {
      id: itemId,
      at: stamp(),
      kind: 'user',
      text: body.text,
      source: 'owner',
      queued,
      memories: [],
      images,
      ...(files.length ? { files } : {}),
      ...(citation ? { citation } : {}),
    })
    const receipt = { inputId: `in-${itemId}`, itemId, queued }
    receipts.set(body.idempotencyKey, { hash, receipt })
    if (queued) queue.set(botId, [...(queue.get(botId) ?? []), itemId])
    else void run(botId, DEMO_SCRIPTS[REPLY_SCRIPT[botId] ?? 'scoutReply'])
    return receipt
  }

  async function lifecycle(botId: string, action: 'start' | 'stop' | 'restart' | 'pause' | 'resume') {
    requireBot(botId)
    if (action === 'stop') {
      cancel(botId, null)
      return updateBot(botId, { lifecycle: 'stopped', status: 'offline', activity: null })
    }
    if (action === 'pause') {
      if (isRunning(botId)) cancel(botId, 'turn_cancelled')
      system(botId, 'paused')
      return updateBot(botId, { paused: true, status: 'paused' })
    }
    if (action === 'resume') {
      system(botId, 'resumed')
      const bot = updateBot(botId, { paused: false, status: 'idle' })
      drain(botId)
      return bot
    }
    if (action === 'restart') cancel(botId, null)
    const starting = updateBot(botId, { lifecycle: 'starting', status: 'starting', activity: null, paused: false })
    setTimeout(() => {
      updateBot(botId, { lifecycle: 'running', status: 'idle' })
      if (action === 'restart') system(botId, 'restarted')
      drain(botId)
    }, 2400 * scale)
    return starting
  }

  /** A bot joins an existing environment, as the phone asks: it sets up its profile, then is ready. */
  function createBot(request: FleetCreateBotRequest): FleetBot {
    const existing = createdBots.get(request.idempotencyKey)
    if (existing) return requireBot(existing)
    const index = world.environments.findIndex((item) => item.id === request.environmentId && item.kind === 'bots')
    if (index < 0) throw new GatewayError('NOT_FOUND', 404, 'Environment not found')
    const environment = world.environments[index]
    if (joinAvailability(environment) === 'full')
      throw new GatewayError('CONFLICT', 409, 'This environment already has its most bots.')
    if (request.talksTo.some((peer) => !bots.has(peer))) throw new GatewayError('NOT_FOUND', 404, 'Peer bot not found')
    const at = stamp()
    const bot = botRecord({
      id: deriveBotId(request.name, bots.keys()),
      name: request.name,
      instructions: request.instructions,
      ceiling: request.ceiling,
      talksTo: request.talksTo,
      tint: ['#4978c6', '#9b65b6', '#d47754', '#4c9a87', '#c29a43', '#6379a5'][bots.size % 6],
      lifecycle: 'creating',
      setup: { step: 'profile', error: null, errorMessage: null },
      status: 'starting',
      environmentId: environment.id,
      createdAt: at,
      updatedAt: at,
    })
    bots.set(bot.id, bot)
    order.push(bot.id)
    transcripts[bot.id] = []
    createdBots.set(request.idempotencyKey, bot.id)
    world.environments[index] = { ...environment, botIds: [...environment.botIds, bot.id], updatedAt: at }
    emit({ type: 'environment.updated', at, environment: world.environments[index] })
    emit({ type: 'bot.updated', at, bot })
    setTimeout(
      () =>
        updateBot(bot.id, {
          lifecycle: 'running',
          setup: { step: 'ready', error: null, errorMessage: null },
          status: 'idle',
        }),
      2400 * scale
    )
    return bot
  }

  const call = (async (key: RouteKey, o: CallOptions<RouteKey> = {}) => {
    const route = FLEET_GATEWAY_ROUTES[key]
    // Bodies are checked as the gateway would, so a mistake in the app shows here too.
    const body = route.body ? route.body.parse(o.body) : undefined
    const id = String(o.params?.id ?? '')
    const lane = lanes.call(key, o, body)
    if (lane !== undefined) return lane
    switch (key) {
      case 'meta':
        return { protocol: 1, gatewayVersion: 'demo', botImage: 'demo', botImageVersion: null, features: DEMO_FEATURES }
      case 'botsList':
        return { bots: order.map((botId) => bots.get(botId)).filter(Boolean) }
      case 'botGet':
        return requireBot(id)
      case 'botsCreate':
        return createBot(body as FleetCreateBotRequest)
      case 'environmentsList':
        return { environments: world.environments }
      case 'inbox':
        return { items: inbox }
      case 'botTranscript': {
        requireBot(id)
        const all = transcripts[id]
        const before = typeof o.query?.before === 'string' ? all.findIndex((item) => item.id === o.query?.before) : -1
        const earlier = before >= 0 ? all.slice(0, before) : all
        const limit = Number(o.query?.limit ?? 200)
        const items = earlier.slice(Math.max(0, earlier.length - limit))
        return { items, before: items.length < earlier.length ? items[0].id : null }
      }
      case 'botMessageSend':
        return send(id, body as FleetSendMessageRequest)
      case 'botInteractionResolve':
        resolve(id, String(o.params?.interactionId), body as FleetInteractionResolution)
        return undefined
      case 'botPatch': {
        requireBot(id)
        const patch = body as FleetPatchBotRequest
        return updateBot(id, {
          ...(patch.selection !== undefined ? { selection: patch.selection } : {}),
          ...(patch.ceiling ? { ceiling: patch.ceiling } : {}),
        })
      }
      case 'botSelections':
        return { options: DEMO_OPTIONS, current: requireBot(id).selection }
      case 'botRoutinesList':
        requireBot(id)
        return { routines: routines[id] ?? [] }
      case 'botRoutineRun': {
        const routine = (routines[id] ?? []).find((item) => item.id === o.params?.rid)
        if (!routine) throw new GatewayError('NOT_FOUND', 404, 'Routine not found')
        const queued = busy(id)
        const itemId = nextId(id)
        upsert(id, {
          id: itemId,
          at: stamp(),
          kind: 'user',
          text: routine.prompt,
          source: 'routine',
          routine: { id: routine.id, title: routine.title },
          queued,
          memories: [],
          images: [],
        })
        if (queued) queue.set(id, [...(queue.get(id) ?? []), itemId])
        else void run(id, DEMO_SCRIPTS.routine)
        const updated = { ...routine, lastRunAt: stamp(), lastOutcome: 'sent' as const }
        routines[id] = (routines[id] ?? []).map((item) => (item.id === routine.id ? updated : item))
        return updated
      }
      case 'botStart':
        return lifecycle(id, 'start')
      case 'botStop':
        return lifecycle(id, 'stop')
      case 'botRestart':
        return lifecycle(id, 'restart')
      case 'botPause':
        return lifecycle(id, 'pause')
      case 'botResume':
        return lifecycle(id, 'resume')
      case 'botCancel':
        requireBot(id)
        if (isRunning(id)) {
          cancel(id, 'turn_cancelled')
          finish(id, null)
        }
        return undefined
      case 'botConversationCall': {
        const bot = requireBot(id)
        const { op } = body as { op: string }
        if (op === 'chatBackgroundCompactionRetry') return { result: { ok: true } }
        if (op !== 'chatCompact') throw new GatewayError('NOT_FOUND', 404, 'The demo server does not offer this')
        if (bot.status !== 'idle' || bot.activity?.kind === 'compacting')
          return { result: { ok: false, error: 'busy' } }
        const before = bot.activity
        updateBot(id, { activity: { kind: 'compacting' } })
        void sleep(2600).then(() => {
          upsert(id, {
            id: nextId(id),
            at: stamp(),
            kind: 'compaction',
            origin: 'manual',
            summary: 'Earlier in this conversation: the work so far, the decisions made and what is still open.',
            truncated: false,
          })
          const current = requireBot(id)
          const used = current.usage?.contextUsedTokens ?? 0
          updateBot(id, {
            activity: before,
            usage: current.usage
              ? { ...current.usage, contextUsedTokens: Math.min(used, 9_000), updatedAt: stamp() }
              : null,
          })
        })
        return { result: { ok: true } }
      }
      case 'devicesSelfDelete':
        return undefined
      case 'devicesList':
        return { devices }
      case 'deviceRevoke': {
        const deviceId = String(o.params?.deviceId ?? '')
        if (deviceId === DEMO_SERVER.id)
          throw new GatewayError('INVALID_REQUEST', 400, 'A device removes itself with DELETE /v1/devices/self')
        if (!devices.some((device) => device.id === deviceId))
          throw new GatewayError('NOT_FOUND', 404, 'Device not found')
        devices = devices.filter((device) => device.id !== deviceId)
        return undefined
      }
      default:
        throw new GatewayError('NOT_FOUND', 404, 'The demo server does not offer this')
    }
  }) as GatewayClient['call']

  return {
    serverId: DEMO_SERVER.id,
    features: DEMO_FEATURES,
    call,
    openEvents(handlers) {
      listeners.add(handlers)
      const hello = () => handlers.onEvent({ type: 'hello', at: stamp(), lastActivitySeq: 0 })
      setTimeout(() => {
        if (!listeners.has(handlers)) return
        handlers.onState('open')
        hello()
        // Juno's nightly run carries on once someone is watching, as in the prototype.
        if (options.autoplay !== false && !autoplayed) {
          autoplayed = true
          void run('juno', DEMO_SCRIPTS.junoNightly)
        }
      }, 0)
      return {
        close() {
          listeners.delete(handlers)
          handlers.onState('closed')
        },
        reconnectNow: hello,
      }
    },
    imageSource: () => ({ uri: PLACEHOLDER_IMAGE }),
    // The demo keeps no files: the phone says so before asking for one.
    fileSource: () => ({ uri: '', headers: {} }),
    // The demo keeps nothing it is sent: any file reads as the placeholder image, which every kind accepts.
    readAttachment: async () => PLACEHOLDER_IMAGE.slice(PLACEHOLDER_IMAGE.indexOf(',') + 1),
  }
}
