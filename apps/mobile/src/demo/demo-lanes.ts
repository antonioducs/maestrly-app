import {
  fleetPeerThreadSchema,
  fleetRoutineRunSchema,
  type FleetBot,
  type FleetGatewayEvent,
  type FleetPeerThread,
  type FleetPeerThreadPatchRequest,
  type FleetPeerThreadSettings,
  type FleetRoutineRunCitation,
  type FleetRoutineRun,
  type FleetRoutineRunSettings,
  type FleetSendMessageRequest,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError, type CallOptions, type RouteKey } from '../gateway/client'

/*
 * The demo server's side conversations: Atlas's routine runs, each in a conversation of its own, and its
 * conversations with Pixel and Juno, apart from its conversation with the owner. Fictional, like the rest of the demo.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** The bot whose runs and threads the demo keeps apart, and the message in its conversation that opened one. */
export const DEMO_LANES_BOT = 'atlas'

type Item = FleetTranscriptItem

export function demoLaneWorld(now: number) {
  const at = (minutesAgo: number, offset = 0) => new Date(now - minutesAgo * MINUTE + offset).toISOString()
  const routine = (id: string, title: string) => ({ id, title })
  const release = routine('r-release', 'Release readiness check')
  const health = routine('r-health', 'Staging health check')
  const prompt = (id: string, time: string, text: string, from: { id: string; title: string }): Item => ({
    id,
    at: time,
    kind: 'user',
    text,
    source: 'routine',
    routine: from,
    queued: false,
    memories: [],
    images: [],
  })
  const said = (id: string, time: string, text: string): Item => ({
    id,
    at: time,
    kind: 'assistant',
    text,
    streaming: false,
  })
  const tool = (id: string, time: string, name: string, target: string, output: string | null): Item => ({
    id,
    at: time,
    kind: 'tool',
    name,
    target,
    state: 'done',
    output,
    images: [],
  })
  const fromPeer = (id: string, time: string, text: string, peer: { botId: string; name: string }): Item => ({
    id,
    at: time,
    kind: 'user',
    text,
    source: 'peer',
    peer,
    queued: false,
    memories: [],
    images: [],
  })
  const run = (fields: Partial<FleetRoutineRun> & Pick<FleetRoutineRun, 'id' | 'routineId' | 'deliveredAt'>) =>
    fleetRoutineRunSchema.parse({
      botId: DEMO_LANES_BOT,
      trigger: 'schedule',
      status: 'completed',
      finishedAt: null,
      report: null,
      finalText: null,
      conversation: 'own',
      expiresAt: new Date(now + 30 * DAY).toISOString(),
      ...fields,
    })

  const releaseText =
    'Check that the release candidate is ready to ship: CI on main, the changelog, and blocking issues.'
  const runs: FleetRoutineRun[] = [
    run({
      id: 'run-release-today',
      routineId: release.id,
      routineTitle: release.title,
      deliveredAt: at(96),
      finishedAt: at(93),
      lastActivityAt: at(93),
      report: {
        summary:
          'rc.2 is ready for staging: CI is green on main, the changelog is complete, and no open issue blocks it.',
        pending: 'Pixel still has to pick the pricing hero layout.',
        notes: 'The only migration adds a nullable column, so the deploy needs no downtime.',
      },
      media: { images: 0, videos: 0, files: 1 },
    }),
    ...[30, 60, 90, 120].map((minutes) =>
      run({
        id: `run-health-${minutes}`,
        routineId: health.id,
        routineTitle: health.title,
        deliveredAt: at(minutes),
        finishedAt: at(minutes, 40_000),
        lastActivityAt: at(minutes, 40_000),
        quiet: true,
        expiresAt: new Date(now + 7 * DAY - minutes * MINUTE).toISOString(),
        report: {
          summary: 'Staging answers in 180 ms on average. Nothing new.',
          pending: null,
          notes: null,
          quiet: true,
        },
      })
    ),
    run({
      id: 'run-release-yesterday',
      routineId: release.id,
      routineTitle: release.title,
      deliveredAt: at(24 * 60 + 96),
      finishedAt: at(24 * 60 + 90),
      lastActivityAt: at(24 * 60 + 90),
      status: 'failed',
      pinned: true,
      expiresAt: null,
      report: {
        summary: 'Couldn’t confirm the release: the staging smoke tests timed out after 10 minutes.',
        pending: 'Run the smoke tests again once staging is back.',
        notes: null,
      },
    }),
  ]
  const transcripts: Record<string, Item[]> = {
    'run-release-today': [
      prompt('rt-1', at(96), releaseText, release),
      tool(
        'rt-2',
        at(95, 10_000),
        'bash',
        'gh run list --branch main --limit 3',
        '✓ CI #4812 · ✓ CI #4809 · ✓ CI #4801'
      ),
      tool('rt-3', at(94, 40_000), 'read', 'CHANGELOG.md', null),
      tool('rt-4', at(94), 'bash', 'gh issue list --label blocker', 'No issues match the filter'),
      said(
        'rt-5',
        at(93),
        'rc.2 is **ready for staging**. CI is green on `main` (#4812), the changelog covers every merged pull request, and no open issue is labeled as a blocker.\n\nOne thing is still open: Pixel hasn’t picked the pricing hero layout yet.'
      ),
    ],
    'run-release-yesterday': [
      prompt('ry-1', at(24 * 60 + 96), releaseText, release),
      {
        id: 'ry-2',
        at: at(24 * 60 + 95),
        kind: 'tool',
        name: 'bash',
        target: 'npm run test:smoke -- --env=staging',
        state: 'error',
        output: 'Timed out after 600 s waiting for staging.example.dev',
        images: [],
      },
      said(
        'ry-3',
        at(24 * 60 + 90),
        'I couldn’t confirm the release: the staging smoke tests **timed out** after 10 minutes. Staging stopped answering at 08:32. I kept this run so you can look at it later.'
      ),
    ],
  }
  for (const minutes of [30, 60, 90, 120])
    transcripts[`run-health-${minutes}`] = [
      prompt(`rh-${minutes}-1`, at(minutes), 'Check that staging answers and how fast.', health),
      tool(
        `rh-${minutes}-2`,
        at(minutes, 20_000),
        'bash',
        'curl -s -o /dev/null -w "%{time_total}" staging.example.dev',
        '0.18'
      ),
      said(`rh-${minutes}-3`, at(minutes, 40_000), 'Staging answers in 180 ms. Nothing new.'),
    ]

  const pixel = { botId: 'pixel', name: 'Pixel' }
  const juno = { botId: 'juno', name: 'Juno' }
  const thread = (fields: Partial<FleetPeerThread> & Pick<FleetPeerThread, 'id' | 'peer' | 'title'>) =>
    fleetPeerThreadSchema.parse({
      botId: DEMO_LANES_BOT,
      origin: 'primary',
      status: 'open',
      hops: 0,
      hopLimit: 8,
      messages: 0,
      pinned: false,
      conversation: 'own',
      report: null,
      reportAt: null,
      working: false,
      peerWorking: false,
      createdAt: at(60),
      lastActivityAt: at(60),
      expiresAt: new Date(now + 30 * DAY).toISOString(),
      conversationDeletedAt: null,
      kept: null,
      ...fields,
    })
  const threads: FleetPeerThread[] = [
    thread({
      id: 'thread-pixel',
      peer: pixel,
      title: 'Pricing hero for rc.2',
      status: 'paused',
      hops: 8,
      messages: 9,
      createdAt: at(40),
      lastActivityAt: at(8),
    }),
    thread({
      id: 'thread-juno',
      peer: juno,
      title: 'Failing admin tests before staging',
      origin: 'peer',
      messages: 4,
      pinned: true,
      expiresAt: null,
      report:
        'Juno confirmed the 3 admin failures come from the rotated staging password, not from rc.2. It will run them again once the login is updated.',
      reportAt: at(24),
      createdAt: at(30),
      lastActivityAt: at(24),
    }),
  ]
  const pixelTalk: Array<[string, boolean]> = [
    ['Pixel, rc.2 ships today. Which hero layout should go with it? I need it before the staging deploy.', false],
    ['Split is the strongest on a desktop, but its plan cards fall below the fold on phones.', true],
    ['How many visitors read pricing on a phone?', false],
    ['About 58% last month. Stacked keeps every plan on screen there.', true],
    ['Then Stacked sounds safer for the release. Can you ship it with the spacing fix?', false],
    ['I can, but changing the hero is a product call. The owner asked me to check with them first.', true],
    ['Agreed. Let’s keep Split ready as an option and ask before the deploy.', false],
    ['I put both in the “Pricing hero options” page so they can compare.', true],
    ['Thanks. Waiting for the owner’s pick.', false],
  ]
  transcripts['thread-pixel'] = pixelTalk.map(([text, peer], index) =>
    peer ? fromPeer(`tp-${index}`, at(40 - index * 4), text, pixel) : said(`tp-${index}`, at(40 - index * 4), text)
  )
  transcripts['thread-juno'] = [
    fromPeer('tj-0', at(30), 'Atlas, 3 admin tests fail on staging. Is rc.2 already deployed there?', juno),
    said('tj-1', at(29), 'Not yet: staging still runs rc.1. The deploy waits for the owner’s approval.'),
    fromPeer('tj-2', at(26), 'Then it isn’t rc.2. They all stop at the login with “Invalid credentials”.', juno),
    said('tj-3', at(24), 'That matches the password rotation from this morning. I’ll tell the owner.'),
  ]
  // In Atlas's own conversation: the owner's request, and the message that opened the thread with Pixel.
  const conversation: Item[] = [
    {
      id: 'atlas-0',
      at: at(41),
      kind: 'user',
      text: 'Check with Pixel which pricing hero ships with rc.2.',
      source: 'owner',
      queued: false,
      memories: [],
      images: [],
    },
    {
      id: 'atlas-0b',
      at: at(40, -5_000),
      kind: 'peer_out',
      to: pixel,
      text: 'Which hero layout should go with rc.2?',
      delivered: true,
      thread: { id: 'thread-pixel' },
    },
  ]
  return { runs, threads, transcripts, conversation }
}

type Deps = {
  emit: (event: FleetGatewayEvent) => void
  stamp: () => string
  nextId: (botId: string) => string
  sleep: (ms: number) => Promise<void>
  requireBot: (id: string) => FleetBot
  updateBot: (id: string, patch: Partial<FleetBot>) => FleetBot
}

/** The routes of the demo's side conversations; `undefined` for a route they do not answer. */
export function createDemoLanes(world: ReturnType<typeof demoLaneWorld>, deps: Deps) {
  const { emit, stamp, nextId, sleep } = deps
  const runs = new Map(world.runs.map((run) => [run.id, run]))
  const threads = new Map(world.threads.map((thread) => [thread.id, thread]))
  const transcripts = world.transcripts
  const notFound = () => new GatewayError('NOT_FOUND', 404, 'Not found')
  const requireRun = (id: string, runId: string) => {
    deps.requireBot(id)
    const run = id === DEMO_LANES_BOT ? runs.get(runId) : undefined
    if (!run) throw notFound()
    return run
  }
  const requireThread = (id: string, threadId: string) => {
    deps.requireBot(id)
    const thread = id === DEMO_LANES_BOT ? threads.get(threadId) : undefined
    if (!thread) throw notFound()
    return thread
  }
  const setRun = (run: FleetRoutineRun) => {
    runs.set(run.id, run)
    emit({ type: 'routine_run.updated', at: stamp(), botId: run.botId, run })
    return run
  }
  const setThread = (thread: FleetPeerThread) => {
    threads.set(thread.id, thread)
    emit({ type: 'peer_thread.updated', at: stamp(), botId: thread.botId, thread })
    return thread
  }
  const add = (botId: string, lane: { kind: 'run' | 'thread'; id: string }, item: Item) => {
    transcripts[lane.id] = [...(transcripts[lane.id] ?? []), item]
    emit(
      lane.kind === 'run'
        ? { type: 'routine_run.transcript.upsert', at: stamp(), botId, runId: lane.id, item }
        : { type: 'peer_thread.transcript.upsert', at: stamp(), botId, threadId: lane.id, item }
    )
  }
  const owner = (botId: string, text: string): Item => ({
    id: nextId(botId),
    at: stamp(),
    kind: 'user',
    text,
    source: 'owner',
    queued: false,
    memories: [],
    images: [],
  })
  const reply = (botId: string, text: string): Item => ({
    id: nextId(botId),
    at: stamp(),
    kind: 'assistant',
    text,
    streaming: false,
  })
  const page = (laneId: string) => ({ items: transcripts[laneId] ?? [], before: null })
  const deleted = (folder: string) => ({ folder, files: [] })

  /** Pixel answers the owner, and the thread waits again after a few messages. */
  async function goOn(botId: string, threadId: string, text: string) {
    await sleep(900)
    add(botId, { kind: 'thread', id: threadId }, reply(botId, text))
    const current = threads.get(threadId)
    if (!current) return
    setThread({ ...current, working: false, messages: current.messages + 1, lastActivityAt: stamp() })
  }

  const call = (key: RouteKey, o: CallOptions<RouteKey>, body: unknown): unknown => {
    const id = String(o.params?.id ?? '')
    const runId = String(o.params?.runId ?? '')
    const threadId = String(o.params?.threadId ?? '')
    switch (key) {
      case 'botRuns':
        deps.requireBot(id)
        return {
          runs:
            id === DEMO_LANES_BOT ? [...runs.values()].sort((a, b) => (a.deliveredAt < b.deliveredAt ? 1 : -1)) : [],
          before: null,
        }
      case 'botRunGet':
        return requireRun(id, runId)
      case 'botRunTranscript':
        requireRun(id, runId)
        return page(runId)
      case 'botRunPatch':
        return setRun({ ...requireRun(id, runId), pinned: (body as { pinned: boolean }).pinned })
      case 'botRunConversationDelete': {
        const run = requireRun(id, runId)
        return setRun({
          ...run,
          conversation: 'deleted',
          conversationDeletedAt: stamp(),
          expiresAt: null,
          kept: deleted(`routines/${run.routineId}/${run.deliveredAt.slice(0, 10)}`),
        })
      }
      case 'botRunMessageSend': {
        const run = requireRun(id, runId)
        if (run.conversation !== 'own') throw new GatewayError('CONFLICT', 409, 'The run has no conversation')
        const input = owner(id, (body as FleetSendMessageRequest).text)
        add(id, { kind: 'run', id: runId }, input)
        setRun({ ...run, adjustments: run.adjustments + 1, lastActivityAt: stamp() })
        void sleep(1100).then(() =>
          add(
            id,
            { kind: 'run', id: runId },
            reply(id, 'Done: I updated this run’s report with that. Your conversation with me stays as it was.')
          )
        )
        return { inputId: `in-${input.id}`, itemId: input.id, queued: false }
      }
      case 'botRunSettings':
        deps.updateBot(id, { runSettings: body as FleetRoutineRunSettings })
        return body
      case 'botPeerThreads':
        deps.requireBot(id)
        return { threads: id === DEMO_LANES_BOT ? [...threads.values()] : [] }
      case 'botPeerThreadGet':
        return requireThread(id, threadId)
      case 'botPeerThreadTranscript':
        requireThread(id, threadId)
        return page(threadId)
      case 'botPeerThreadPatch': {
        const thread = requireThread(id, threadId)
        const patch = body as FleetPeerThreadPatchRequest
        const resumed = patch.resume && thread.status === 'paused'
        const next = setThread({
          ...thread,
          ...(patch.pinned !== undefined
            ? { pinned: patch.pinned, expiresAt: patch.pinned ? null : thread.expiresAt }
            : {}),
          ...(resumed ? { status: 'open' as const, hops: 0, working: true } : {}),
        })
        if (resumed)
          void goOn(id, threadId, 'Pixel, let’s get Stacked ready with the spacing fix while the owner decides.')
        return next
      }
      case 'botPeerThreadConversationDelete':
        return setThread({
          ...requireThread(id, threadId),
          conversation: 'deleted',
          conversationDeletedAt: stamp(),
          expiresAt: null,
          kept: deleted(`bots/${threadId}`),
        })
      case 'botPeerThreadMessageSend': {
        const thread = requireThread(id, threadId)
        if (thread.conversation !== 'own') throw new GatewayError('CONFLICT', 409, 'The thread has no conversation')
        const input = owner(id, (body as FleetSendMessageRequest).text)
        add(id, { kind: 'thread', id: threadId }, input)
        // The owner's word starts the bots' messages in a row again.
        setThread({
          ...thread,
          status: 'open',
          hops: 0,
          working: true,
          messages: thread.messages + 1,
          lastActivityAt: stamp(),
        })
        void goOn(id, threadId, 'Understood. I’ll pass that on to Pixel.')
        return { inputId: `in-${input.id}`, itemId: input.id, queued: false }
      }
      case 'botPeerThreadSettings':
        deps.updateBot(id, { peerSettings: body as FleetPeerThreadSettings })
        return body
      default:
        return undefined
    }
  }
  /** What the bot's conversation shows of a run an owner's message cites, as a gateway records it. */
  const citation = (runId: string): FleetRoutineRunCitation | null => {
    const run = runs.get(runId)
    return run ? { runId, routineTitle: run.routineTitle ?? '', at: run.finishedAt ?? run.deliveredAt } : null
  }
  return { call, citation }
}
