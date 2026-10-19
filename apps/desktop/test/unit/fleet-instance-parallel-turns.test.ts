import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLEET_BOT_DELEGATION_DEFAULT,
  FLEET_BOT_SIDE_TURNS_MAX,
  type FleetInstanceEvent,
} from '@maestrly/bot-fleet-protocol'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', async (importOriginal) => {
  const original = await importOriginal<typeof import('electron')>()
  return { ...original, app: { ...original.app, getPath: () => h.userData } }
})

const { closeDb, freshDb } = await import('../helpers/db')
const { upsertChatMessage } = await import('../../src/main/chat/chat-store')
const chatService = await import('../../src/main/chat/service')
const { createStandaloneConversation } = await import('../../src/main/standalone-conversation-service')
const { deleteConversation } = await import('../../src/main/workspace-service')
const { InstanceInputQueue, conversationQueue } = await import('../../src/main/fleet/instance/queue')
const { InstanceTranscriptExtras } = await import('../../src/main/fleet/instance/transcript')
const { FleetImageStore } = await import('../../src/main/fleet/instance/images')
const { LiveTranscript } = await import('../../src/main/fleet/instance/live-transcript')
const { InstanceEvents } = await import('../../src/main/fleet/instance/server')
const { InstanceHelpStore } = await import('../../src/main/fleet/instance/help')
const { InstanceHoldManager } = await import('../../src/main/fleet/instance/gate')
const { BotRunConversations } = await import('../../src/main/fleet/instance/routine-runs')
const { BotRuntime } = await import('../../src/main/fleet/instance/runtime')
const { subagentConcurrencyOf } = await import('../../src/main/chat/subagent-concurrency')
const { botTaskPolicyPrompt } = await import('../../src/main/fleet/instance/task-policy')
const { getSubagentRouter } = await import('../../src/main/chat/subagent-route')
const { getSubscriptionFailoverRouter, resetSubscriptionFailoverRouterForTests } = await import(
  '../../src/main/chat/subscription-failover/router'
)

let dir = ''
beforeEach(async () => {
  h.userData = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-parallel-')))
  dir = path.join(h.userData, 'bot')
  freshDb()
})
afterEach(async () => {
  vi.restoreAllMocks()
  resetSubscriptionFailoverRouterForTests()
  closeDb()
  await rm(h.userData, { recursive: true, force: true })
})

const profile = {
  botId: 'alpha',
  name: 'Atlas',
  instructions: '',
  ceiling: 'full' as const,
  selection: null,
  compaction: null,
  gateway: { peersEnabled: false, artifactsEnabled: false, desktopBridgeEnabled: false, routineConversations: true },
}

type Runtime = InstanceType<typeof BotRuntime>
type Internals = {
  turns: Map<string | null, { inputId: string; key: string | null }>
  retries: Map<string | null, { at: number; failures: number }>
  quotaRetryAt: number
}
const internals = (runtime: Runtime) => runtime as unknown as Internals

/**
 * A bot runtime over its real queue, transcripts, run conversations and events, in a real primary conversation; its
 * accounts, model and usage are stubs, and the turns themselves are the test's.
 */
async function bot() {
  const primary = await createStandaloneConversation({ name: 'Atlas' })
  const events = new InstanceEvents()
  const published: FleetInstanceEvent[] = []
  events.subscribe((event) => published.push(event))
  const queue = new InstanceInputQueue(path.join(dir, 'inputs.json'), path.join(dir, 'attachments'))
  const images = new FleetImageStore(path.join(dir, 'images'))
  const runtime = Object.create(BotRuntime.prototype) as Runtime
  const publish = (event: Parameters<InstanceType<typeof InstanceEvents>['publish']>[0]) =>
    events.publish({ ...event, botId: 'alpha' })
  const extras = new InstanceTranscriptExtras(path.join(dir, 'transcript.json'), (item) =>
    publish({ type: 'transcript.upsert', item })
  )
  const turns = new Map<string | null, { inputId: string; key: string | null }>()
  const runs = new BotRunConversations({
    file: path.join(dir, 'runs.json'),
    folder: path.join(dir, 'runs'),
    queue,
    images,
    publish: (runId, item) => publish({ type: 'transcript.upsert', item, runId }),
    turnInputId: (runId) => turns.get(runId)?.inputId ?? null,
    changed: () => {},
  })
  const host = {
    gatewayUrl: null,
    floatBrowser: vi.fn(),
    present: vi.fn(),
    closeConversation: vi.fn(async () => {}),
    purgeConversation: vi.fn(async (id: string) => deleteConversation(id)),
  }
  Object.assign(runtime, {
    botId: 'alpha',
    disposed: false,
    ready: true,
    stored: { profile, primaryConversationId: primary.id },
    host,
    events,
    queue,
    images,
    extras,
    runs,
    help: new InstanceHelpStore(extras, () => {}),
    live: new LiveTranscript({
      conversationId: () => primary.id,
      queue: conversationQueue(queue, null),
      extras,
      images,
      publish: (item) => publish({ type: 'transcript.upsert', item }),
      turnInputId: () => turns.get(null)?.inputId ?? null,
    }),
    holdManager: new InstanceHoldManager(),
    ownerMemory: { coreSections: async () => [], writer: () => ({}) },
    accountOptions: [{ providerId: 'p', modelId: 'm' }],
    compactionProblem: null,
    manualCompacting: false,
    editing: false,
    turns,
    retries: new Map(),
    quotaRetryAt: 0,
    reportedStartFailure: null,
    interrupted: new Set(),
    releaseKeys: new Map(),
    floatTimers: new Set(),
    permissionTools: new Map(),
    permissionAt: new Map(),
    questionAt: new Map(),
    questionItems: new Map(),
    presentOnCompletion: new Map(),
    opening: new Map(),
    refreshAccounts: async () => {},
    refreshUsage: async () => {},
    applyProfile: () => {},
    currentSelection: () => null,
    changed: () => {},
    // Turns start when the test runs the dispatcher (`turn`), not on their own after each input.
    tick: async () => {},
  })
  await queue.load()
  await runs.load()
  return { runtime, primary, published, runs, queue }
}

const ownerInput = (text: string) => ({
  idempotencyKey: randomUUID(),
  source: 'owner' as const,
  text,
  attachments: [],
})
const routineInput = (runId: string) => ({
  idempotencyKey: randomUUID(),
  source: 'routine' as const,
  text: 'Post the week photo.',
  routine: { id: 'post', title: 'Post da semana', runId, previousRuns: [] },
  run: { id: runId },
  attachments: [],
})

type Started = { conversationId: string; finish: () => void }
/**
 * Turns the test ends itself: each one writes its prompt in the conversation it got when it starts, and its answer
 * when the test finishes it. A conversation for which `fail` returns an error does not start.
 */
function heldTurns(fail: (conversationId: string) => Error | null = () => null) {
  const started: Started[] = []
  const attempts: string[] = []
  vi.spyOn(chatService, 'acquireChatConversationSlot').mockResolvedValue({
    release: () => {},
    operation: {},
  } as never)
  vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
    attempts.push(input.conversationId)
    const error = fail(input.conversationId)
    if (error) throw error
    const index = started.length + 1
    const assistantId = `assistant-${index}-${randomUUID()}`
    upsertChatMessage({
      id: 'user-' + randomUUID(),
      conversationId: input.conversationId,
      role: 'user',
      createdAt: Date.now(),
      parts: [{ type: 'text', id: randomUUID(), text: input.prompt }],
    })
    input.slot?.release()
    let finish!: () => void
    const done = new Promise<{ status: 'success'; assistantMessageId: string }>((resolve) => {
      finish = () => {
        upsertChatMessage({
          id: assistantId,
          conversationId: input.conversationId,
          role: 'assistant',
          createdAt: Date.now() + 1,
          parts: [{ type: 'text', id: randomUUID(), text: 'Done.' }],
          finishReason: 'stop',
        })
        resolve({ status: 'success', assistantMessageId: assistantId })
      }
    })
    started.push({ conversationId: input.conversationId, finish })
    return {
      executionId: input.conversationId,
      conversationId: input.conversationId,
      assistantMessageId: () => assistantId,
      cancel: () => {},
      done,
    }
  })
  return { started, attempts }
}

type Tick = { tick(): Promise<void> }
/** Runs the bot's dispatcher once: it resolves when the turns it started have ended. */
const turn = (runtime: Runtime) => (BotRuntime.prototype as unknown as Tick).tick.call(runtime)

describe('turns of the bot conversations at the same time', () => {
  it("runs a routine run's turn while the bot's own turn runs", async () => {
    const { runtime, primary, runs } = await bot()
    const { started } = heldTurns()
    await runtime.input(ownerInput('Plan the week'))
    const first = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const second = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    const record = runs.get(runId)!
    expect(started.map((entry) => entry.conversationId)).toEqual([primary.id, record.conversationId])
    expect((await runtime.status()).turns.map((entry) => entry.runId)).toEqual([null, runId])
    for (const entry of started) entry.finish()
    await Promise.all([first, second])
    expect((await runtime.status()).turns).toEqual([])
  })

  it("keeps a second input of a conversation waiting for that conversation's turn", async () => {
    const { runtime } = await bot()
    const { started } = heldTurns()
    await runtime.input(ownerInput('First task'))
    await runtime.input(ownerInput('Second task'))
    const first = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    await turn(runtime)
    expect(started).toHaveLength(1)
    started[0].finish()
    await first
    const second = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    started[1].finish()
    await second
  })

  it(`starts the bot's own turn and at most ${FLEET_BOT_SIDE_TURNS_MAX} side turns`, async () => {
    const { runtime, primary } = await bot()
    const { started } = heldTurns()
    const runIds = Array.from({ length: FLEET_BOT_SIDE_TURNS_MAX + 1 }, () => randomUUID())
    for (const runId of runIds) await runtime.input(routineInput(runId))
    await runtime.input(ownerInput('Plan the week'))
    const first = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(FLEET_BOT_SIDE_TURNS_MAX + 1))
    expect(started.filter((entry) => entry.conversationId === primary.id)).toHaveLength(1)
    await turn(runtime)
    expect(started).toHaveLength(FLEET_BOT_SIDE_TURNS_MAX + 1)
    // A side turn that ends lets the side conversation that waits start.
    started.find((entry) => entry.conversationId !== primary.id)!.finish()
    await vi.waitFor(() => expect(internals(runtime).turns.size).toBe(FLEET_BOT_SIDE_TURNS_MAX))
    const next = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(FLEET_BOT_SIDE_TURNS_MAX + 2))
    for (const entry of started) entry.finish()
    await Promise.all([first, next])
  })

  it('a failure to start delays only its conversation', async () => {
    const { runtime, primary, runs } = await bot()
    const { started, attempts } = heldTurns((conversationId) =>
      conversationId === primary.id ? null : new Error('boom')
    )
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    await turn(runtime)
    const record = runs.get(runId)!
    expect(attempts).toEqual([record.conversationId])
    expect(internals(runtime).retries.get(runId)!.at).toBeGreaterThan(Date.now())
    await runtime.input(ownerInput('Plan the week'))
    const own = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    // The bot's own conversation starts; the run waits out its own delay.
    expect(attempts).toEqual([record.conversationId, primary.id])
    started[0].finish()
    await own
    internals(runtime).retries.set(runId, { at: 0, failures: 1 })
    await turn(runtime)
    expect(attempts).toEqual([record.conversationId, primary.id, record.conversationId])
  })

  it('a usage limit stops every conversation', async () => {
    const { runtime } = await bot()
    Object.assign(runtime, {
      currentSelection: () => ({ providerId: 'builtin_claude_subscription', modelId: 'claude-test' }),
    })
    getSubscriptionFailoverRouter().markExhausted('builtin_claude_subscription', {
      reason: 'usage limit',
      source: 'structured-error',
      resetsAt: Date.now() + 60 * 60_000,
    })
    const { attempts } = heldTurns(() => new Error('claude-accounts-exhausted'))
    await runtime.input(routineInput(randomUUID()))
    await turn(runtime)
    expect(attempts).toHaveLength(1)
    expect(internals(runtime).quotaRetryAt).toBeGreaterThan(Date.now())
    // The bot's own conversation shares the accounts: work waiting there does not start either. (The owner writing
    // tries again at once, so the input is queued here as one that did not just arrive.)
    await runtime.queue.enqueue(ownerInput('Plan the week'))
    await turn(runtime)
    expect(attempts).toHaveLength(1)
  })

  it("edits the owner's last message while a routine run works", async () => {
    const { runtime } = await bot()
    const { started } = heldTurns()
    const receipt = await runtime.input(ownerInput('First task'))
    const own = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    started[0].finish()
    await own
    await runtime.input(routineInput(randomUUID()))
    const run = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    vi.mocked(chatService.acquireChatConversationSlot).mockRestore()
    const edited = await runtime.editInput(receipt.inputId, {
      text: 'First task, done differently',
      idempotencyKey: randomUUID(),
    })
    expect(edited).toMatchObject({ queued: true })
    started[1].finish()
    await run
  })

  it('takes the screen from every working conversation, and continues each in its own once given back', async () => {
    const { runtime, queue } = await bot()
    const { started } = heldTurns()
    const stop = vi.spyOn(chatService, 'stopChatAndWait').mockResolvedValue(undefined as never)
    await runtime.input(ownerInput('Plan the week'))
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const both = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    const conversations = started.map((entry) => entry.conversationId)
    const state = await runtime.hold('takeover')
    expect(state).toMatchObject({ state: 'held', interruptedTurn: true })
    expect(stop.mock.calls.map(([id]) => id).sort()).toEqual([...conversations].sort())
    for (const entry of started) entry.finish()
    await both
    // A release that fails half way is retried with the same continuations.
    const system = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    Object.assign(runtime, { system })
    const request = { note: null, durationMs: 60_000, continue: true }
    await expect(runtime.release(request)).rejects.toThrow('disk full')
    expect(await runtime.release(request)).toMatchObject({ state: 'none' })
    const continuations = queue.list().filter((item) => item.input.source === 'continuation')
    expect(continuations.map((item) => item.input.run?.id ?? null).sort()).toEqual([null, runId].sort())
  })

  it('continues every conversation that asked for help when the owner gives the screen back', async () => {
    const { runtime, queue } = await bot()
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const lane = await (
      runtime as unknown as { runLane(id: string): Promise<{ help: InstanceType<typeof InstanceHelpStore> }> }
    ).runLane(runId)
    await lane.help.requestHelp('Log in to the photo site')
    await runtime.help.requestHelp('Approve the payment')
    Object.assign(runtime, { system: vi.fn(async () => {}) })
    await runtime.hold('takeover')
    await runtime.release({ note: 'Done', durationMs: 30_000, continue: true })
    const continuations = queue.list().filter((item) => item.input.source === 'continuation')
    expect(continuations.map((item) => item.input.run?.id ?? null).sort()).toEqual([null, runId].sort())
    expect(lane.help.pending()).toEqual([])
    expect(runtime.help.pending()).toEqual([])
  })

  it("stops one conversation's turn, or every turn", async () => {
    const { runtime, primary, runs } = await bot()
    const { started } = heldTurns()
    const stop = vi.spyOn(chatService, 'stopChatAndWait').mockResolvedValue(undefined as never)
    await runtime.input(ownerInput('Plan the week'))
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const both = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    const record = runs.get(runId)!
    await runtime.cancel(runId)
    expect(stop.mock.calls.map(([id]) => id)).toEqual([record.conversationId])
    expect((await runtime.status()).turns.map((entry) => [entry.runId, entry.state])).toEqual([
      [null, 'running'],
      [runId, 'cancelling'],
    ])
    await runtime.cancel()
    expect(
      stop.mock.calls
        .map(([id]) => id)
        .slice(1)
        .sort()
    ).toEqual([primary.id, record.conversationId].sort())
    for (const entry of started) entry.finish()
    await both
  })

  it('answers currentInput for each conversation', async () => {
    const { runtime, primary, runs } = await bot()
    const { started } = heldTurns()
    await runtime.input(ownerInput('Plan the week'))
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const both = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(2))
    const record = runs.get(runId)!
    expect(runtime.currentInput(primary.id)?.source).toBe('owner')
    expect(runtime.currentInput(record.conversationId)).toMatchObject({
      source: 'routine',
      routine: { runId },
      run: { id: runId },
    })
    for (const entry of started) entry.finish()
    await both
    expect(runtime.currentInput(primary.id)).toBeNull()
  })

  it("limits the tasks of every conversation of the bot together, and forgets a deleted run's", async () => {
    const { runtime, primary, runs } = await bot()
    const { started } = heldTurns()
    ;(BotRuntime.prototype as unknown as { applyProfile(): void }).applyProfile.call(runtime)
    expect(subagentConcurrencyOf(primary.id)).toEqual({ pool: 'alpha', limit: 4 })
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const running = turn(runtime)
    await vi.waitFor(() => expect(started).toHaveLength(1))
    const record = runs.get(runId)!
    expect(subagentConcurrencyOf(record.conversationId)).toEqual({ pool: 'alpha', limit: 4 })
    started[0]!.finish()
    await running
    await runtime.deleteRun(runId)
    expect(subagentConcurrencyOf(record.conversationId)).toBeNull()
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    expect(botTaskPolicyPrompt(primary.id)).toContain('at most 4 run at once')
    expect(botTaskPolicyPrompt(record.conversationId)).toBe('')
    vi.unstubAllEnvs()
  })

  it('routes the tasks of a delegating bot in its own conversation, and in side ones only when the owner says so', async () => {
    const { runtime, primary, runs } = await bot()
    const { started } = heldTurns()
    const stored = (runtime as unknown as { stored: { profile: Record<string, unknown> } }).stored
    const install = (delegation: Partial<typeof FLEET_BOT_DELEGATION_DEFAULT>) => {
      stored.profile = { ...profile, delegation: { ...FLEET_BOT_DELEGATION_DEFAULT, ...delegation } }
      ;(BotRuntime.prototype as unknown as { applyProfile(): void }).applyProfile.call(runtime)
    }
    const runTurn = async () => {
      const runId = randomUUID()
      await runtime.input(routineInput(runId))
      const running = turn(runtime)
      await vi.waitFor(() => expect(started.length).toBeGreaterThan(0))
      const conversationId = runs.get(runId)!.conversationId
      const routed = getSubagentRouter(conversationId) !== null
      started.splice(0).forEach((entry) => entry.finish())
      await running
      return routed
    }

    install({ mode: 'delegate', maxTasks: 2 })
    expect(getSubagentRouter(primary.id)).not.toBeNull()
    expect(subagentConcurrencyOf(primary.id)?.limit).toBe(2)
    expect(await runTurn()).toBe(false)

    install({ mode: 'delegate', sideConversations: true })
    expect(await runTurn()).toBe(true)

    install({ mode: 'normal' })
    expect(getSubagentRouter(primary.id)).toBeNull()
  })
})
