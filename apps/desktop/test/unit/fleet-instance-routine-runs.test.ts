import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetInstanceEvent } from '@maestrly/bot-fleet-protocol'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', async (importOriginal) => {
  const original = await importOriginal<typeof import('electron')>()
  return { ...original, app: { ...original.app, getPath: () => h.userData } }
})

const { closeDb, freshDb } = await import('../helpers/db')
const { getConversation, getDb } = await import('../../src/main/store')
const { upsertChatMessage } = await import('../../src/main/chat/chat-store')
const chatService = await import('../../src/main/chat/service')
const { saveGeneratedImage } = await import('../../src/main/chat/generated-images')
const { createStandaloneConversation } = await import('../../src/main/standalone-conversation-service')
const { deleteConversation } = await import('../../src/main/workspace-service')
const { InstanceInputQueue, conversationQueue, inputRunId, promptForInput, RUN_CONVERSATION_NOTE } = await import(
  '../../src/main/fleet/instance/queue'
)
const { InstanceTranscriptExtras } = await import('../../src/main/fleet/instance/transcript')
const { FleetImageStore } = await import('../../src/main/fleet/instance/images')
const { LiveTranscript } = await import('../../src/main/fleet/instance/live-transcript')
const { InstanceEvents, InstanceHttpError } = await import('../../src/main/fleet/instance/server')
const { InstanceHelpStore } = await import('../../src/main/fleet/instance/help')
const { InstanceHoldManager } = await import('../../src/main/fleet/instance/gate')
const {
  BotRunConversations,
  RunLane: RunLaneClass,
  readRunConversationIds,
} = await import('../../src/main/fleet/instance/routine-runs')
const { ThreadReports, THREAD_REPORT_LIMITS } = await import('../../src/main/fleet/instance/thread-reports')
const { conversationScreen } = await import('../../src/main/conversation-screen')
const { conversationShellEnv } = await import('../../src/main/chat/conversation-env')
const { laneKeptFolder, runKeptFolder } = await import('../../src/main/fleet/instance/run-files')
const { BotRuntime, openingContext } = await import('../../src/main/fleet/instance/runtime')
const { APP_TOOL_POLICY } = await import('../../src/main/chat/tool-policy')

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let dir = ''
beforeEach(async () => {
  h.userData = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fleet-runs-')))
  dir = path.join(h.userData, 'bot')
  freshDb()
})
afterEach(async () => {
  vi.restoreAllMocks()
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

/**
 * A bot runtime over its real queue, transcripts, run conversations and events, in a real primary conversation; its
 * accounts, model and usage are stubs, and the turn itself is the test's.
 */
async function bot() {
  const primary = await createStandaloneConversation({ name: 'Atlas' })
  const events = new InstanceEvents()
  const published: FleetInstanceEvent[] = []
  events.subscribe((event) => published.push(event))
  const queue = new InstanceInputQueue(path.join(dir, 'inputs.json'), path.join(dir, 'attachments'))
  const images = new FleetImageStore(path.join(dir, 'images'))
  const runtime = Object.create(BotRuntime.prototype) as InstanceType<typeof BotRuntime>
  const publish = (event: Parameters<InstanceType<typeof InstanceEvents>['publish']>[0]) =>
    events.publish({ ...event, botId: 'alpha' })
  const extras = new InstanceTranscriptExtras(path.join(dir, 'transcript.json'), (item) =>
    publish({ type: 'transcript.upsert', item })
  )
  let turnInputId: (runId: string) => string | null = () => null
  const runs = new BotRunConversations({
    file: path.join(dir, 'runs.json'),
    threadsFile: path.join(dir, 'threads.json'),
    folder: path.join(dir, 'runs'),
    queue,
    images,
    publish: (runId, item) => publish({ type: 'transcript.upsert', item, runId }),
    turnInputId: (runId) => turnInputId(runId),
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
    threadReports: new ThreadReports(path.join(dir, 'thread-reports.json')),
    help: new InstanceHelpStore(extras, () => {}),
    live: new LiveTranscript({
      conversationId: () => primary.id,
      queue: conversationQueue(queue, null),
      extras,
      images,
      publish: (item) => publish({ type: 'transcript.upsert', item }),
    }),
    holdManager: new InstanceHoldManager(),
    ownerMemory: { coreSections: async () => [], writer: () => ({}) },
    accountOptions: [{ providerId: 'p', modelId: 'm' }],
    compactionProblem: null,
    manualCompacting: false,
    editing: false,
    turns: new Map(),
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
    // Turns start when the test runs one (`turn`), not on their own after each input.
    tick: async () => {},
  })
  turnInputId = (runId) =>
    (runtime as unknown as { turns: Map<string | null, { inputId: string }> }).turns.get(runId)?.inputId ?? null
  await queue.load()
  await runs.load()
  return { runtime, primary, published, runs, queue, host }
}

const routineInput = (runId: string) => ({
  idempotencyKey: randomUUID(),
  source: 'routine' as const,
  text: 'Post the week photo.',
  routine: { id: 'post', title: 'Post da semana', runId, previousRuns: [] },
  run: { id: runId },
  attachments: [],
})

/** The turn the bot runs: it writes the answer, and with `image` a generated image, in the conversation it got. */
function answer(text: string, options: { image?: boolean } = {}) {
  const conversations: string[] = []
  const start = vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
    conversations.push(input.conversationId)
    const parts: Parameters<typeof upsertChatMessage>[0]['parts'] = [{ type: 'text', id: randomUUID(), text }]
    if (options.image) {
      const stored = await saveGeneratedImage({
        conversationId: input.conversationId,
        result: PNG_1X1_BASE64,
        label: 'post semana',
      })
      parts.push(
        {
          type: 'tool',
          id: randomUUID(),
          toolCallId: randomUUID(),
          toolName: 'generate_image',
          input: {},
          state: { status: 'completed', output: 'Image saved' },
        },
        { type: 'generated-image', id: randomUUID(), ...stored }
      )
    }
    upsertChatMessage({
      id: 'user-' + randomUUID(),
      conversationId: input.conversationId,
      role: 'user',
      createdAt: Date.now(),
      parts: [{ type: 'text', id: randomUUID(), text: input.prompt }],
    })
    upsertChatMessage({
      id: 'assistant-' + conversations.length,
      conversationId: input.conversationId,
      role: 'assistant',
      createdAt: Date.now() + 1,
      parts,
      finishReason: 'stop',
    })
    input.slot?.release()
    return {
      executionId: input.conversationId,
      conversationId: input.conversationId,
      assistantMessageId: () => 'assistant-' + conversations.length,
      cancel: () => {},
      done: Promise.resolve({ status: 'success' as const, assistantMessageId: 'assistant-' + conversations.length }),
    }
  })
  return { start, conversations }
}

type Tick = { tick(): Promise<void> }
/** Runs the bot's next turn, as its dispatcher would. */
const turn = (runtime: InstanceType<typeof BotRuntime>) => (BotRuntime.prototype as unknown as Tick).tick.call(runtime)

describe('routine runs in conversations of their own', () => {
  it("opens a run's conversation in the bot's folder and shows its items only as the run's", async () => {
    const { runtime, primary, published, runs } = await bot()
    const runId = randomUUID()
    const receipt = await runtime.input(routineInput(runId))
    const record = runs.get(runId)!
    expect(record).toMatchObject({ routineId: 'post', routineTitle: 'Post da semana' })
    const conversation = getConversation(record.conversationId)
    expect(conversation).toMatchObject({ scope: 'standalone', cwd: primary.cwd, folderOwnerId: primary.id })
    expect(runtime.ownsConversation(record.conversationId)).toBe(true)
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'transcript.upsert', runId, item: expect.objectContaining({ queued: true }) })
    )
    // The bot's own transcript does not show the run; the run's does.
    expect((await runtime.transcript(null, 50)).items).toEqual([])
    expect((await runtime.runTranscript(runId, null, 50)).items).toEqual([
      expect.objectContaining({ id: receipt.itemId, source: 'routine', queued: true }),
    ])
    // A retry of the same input keeps the run's one conversation.
    await runtime.input({ ...routineInput(runId), idempotencyKey: randomUUID() })
    expect(runs.list()).toHaveLength(1)
  })

  it("runs the turn in the run's conversation, reports it as the run's and gives back what it opened", async () => {
    const { runtime, primary, published, runs, host } = await bot()
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const { conversations } = answer('Posted.', { image: true })
    let during: ReturnType<typeof runtime.currentInput> = null
    let foreground: string | null = null
    vi.spyOn(chatService, 'acquireChatConversationSlot').mockImplementation(async () => {
      during = runtime.currentInput(runs.get(runId)!.conversationId)
      foreground = runtime.foregroundConversationId
      return { release: () => {}, operation: {} } as never
    })
    await turn(runtime)
    const record = runs.get(runId)!
    expect(conversations).toEqual([record.conversationId])
    // The run works out of sight: the bot's desktop keeps showing its own conversation.
    expect(foreground).toBe(primary.id)
    expect(during).toMatchObject({ source: 'routine', routine: { runId }, run: { id: runId } })
    const finished = published.find((event) => event.type === 'turn.finished')
    expect(finished).toMatchObject({ runId, outcome: 'completed', text: 'Posted.', media: { images: 1 } })
    expect(host.closeConversation).toHaveBeenCalledWith(record.conversationId)
    expect(runtime.foregroundConversationId).toBe(primary.id)
    // The prompt says the conversation is the run's own and asks whether it found anything new.
    expect(promptForInput(routineInput(runId))).toContain(RUN_CONVERSATION_NOTE)
    expect(promptForInput(routineInput(runId))).toContain('nothing_new')
  })

  it("keeps a run off the bot's desktop, and brings it forward only while it asks the owner for help", async () => {
    const { runtime, primary, runs } = await bot()
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const record = runs.get(runId)!
    const area = { x: 1280, y: 0, width: 1280, height: 800 }
    Object.assign(runtime, {
      screen: {
        display: ':3',
        width: 1280,
        height: 800,
        browserArea: area,
        env: {
          DISPLAY: ':3',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/bus',
          BROWSER: '/usr/local/bin/maestrly-open-url',
          MAESTRLY_BOT_BROWSER_PROFILE: '/profile',
          GTK_THEME: 'Adwaita:dark',
          MAESTRLY_DESKTOP_SOCKET: '/desktop.sock',
        },
      },
    })
    const internals = runtime as unknown as {
      runLane(runId: string): Promise<InstanceType<typeof RunLaneClass>>
      registerRun(lane: InstanceType<typeof RunLaneClass>): void
    }
    const lane = await internals.runLane(runId)
    internals.registerRun(lane)
    try {
      // Its browser shows in the bot's area when it comes forward; its programs open on no desktop of the bot's.
      expect(conversationScreen(record.conversationId)).toEqual({
        display: ':3',
        width: 1280,
        height: 800,
        windowArea: area,
      })
      const env = conversationShellEnv(record.conversationId)
      expect(env).toMatchObject({ DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '', MAESTRLY_DESKTOP_SOCKET: '' })
      expect(env.BROWSER).toBe('/usr/local/bin/maestrly-open-url')
      expect(runtime.foregroundConversationId).toBe(primary.id)
      await lane.help.requestHelp('Log in to the photo site')
      expect(runtime.foregroundConversationId).toBe(record.conversationId)
      // The bot's own conversation asking for help keeps the desktop.
      const own = await runtime.help.requestHelp('Approve the payment')
      expect(runtime.foregroundConversationId).toBe(primary.id)
      await runtime.help.resolve(own, null)
      await lane.help.resolveAll(null)
      expect(runtime.foregroundConversationId).toBe(primary.id)
    } finally {
      lane.unregister?.()
    }
  })

  it("takes the owner's changes in the run's conversation, and none for a run without one", async () => {
    const { runtime, runs } = await bot()
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    answer('Posted.')
    vi.spyOn(chatService, 'acquireChatConversationSlot').mockResolvedValue({
      release: () => {},
      operation: {},
    } as never)
    await turn(runtime)
    const followUp = await runtime.input({
      idempotencyKey: randomUUID(),
      source: 'owner',
      text: 'Make the photo brighter',
      run: { id: runId },
      attachments: [],
    })
    expect((await runtime.runTranscript(runId, null, 50)).items).toContainEqual(
      expect.objectContaining({ id: followUp.itemId, source: 'owner', queued: true })
    )
    await expect(
      runtime.input({
        idempotencyKey: randomUUID(),
        source: 'owner',
        text: 'Hello',
        run: { id: randomUUID() },
        attachments: [],
      })
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      runtime.input({ ...routineInput('../escape'), routine: { id: 'post', title: 'x', runId: '../escape' } })
    ).rejects.toBeInstanceOf(InstanceHttpError)
    const { conversations } = answer('Brighter now.')
    let during: ReturnType<typeof runtime.currentInput> = null
    vi.spyOn(chatService, 'acquireChatConversationSlot').mockImplementation(async () => {
      during = runtime.currentInput(runs.get(runId)!.conversationId)
      return { release: () => {}, operation: {} } as never
    })
    await turn(runtime)
    expect(conversations).toEqual([runs.get(runId)!.conversationId])
    // The routine's metadata stays with an owner's change, so the run's report can be updated.
    expect(during).toMatchObject({ source: 'owner', routine: { id: 'post', runId }, run: { id: runId } })
    expect(runtime.currentInput(runs.get(runId)!.conversationId)).toBeNull()
  })

  it('asks the bot to read a cited run with the tool that reads runs', () => {
    const prompt = promptForInput({
      idempotencyKey: randomUUID(),
      source: 'owner',
      text: 'What did it post?',
      citation: { runId: 'run-1', routineTitle: 'Post', at: '2026-10-18T09:00:00.000Z' },
    })
    expect(prompt).toContain('What did it post?')
    expect(prompt).toContain('run id run-1')
    const tool = prompt.match(/Read it with (\w+)/)?.[1]
    expect(tool && tool in APP_TOOL_POLICY).toBe(true)
  })

  it("deletes a run's conversation, keeping its images in the bot's folder", async () => {
    const { runtime, primary, runs, queue, host } = await bot()
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    answer('Posted.', { image: true })
    vi.spyOn(chatService, 'acquireChatConversationSlot').mockResolvedValue({
      release: () => {},
      operation: {},
    } as never)
    await turn(runtime)
    const record = runs.routine(runId)!
    await writeFile(path.join(primary.cwd, 'prices.csv'), 'a,b\n')
    await runtime.input({
      idempotencyKey: randomUUID(),
      source: 'owner',
      text: 'Later',
      run: { id: runId },
      attachments: [],
    })
    const deleted = await runtime.deleteRun(runId)
    expect(deleted.kept.folder).toBe(runKeptFolder(record))
    expect(deleted.kept.files).toEqual([
      expect.objectContaining({ kind: 'image', name: expect.stringMatching(/\.png$/) }),
    ])
    const kept = path.join(primary.cwd, ...deleted.kept.folder.split('/'), deleted.kept.files[0].name)
    expect((await readFile(kept)).subarray(1, 4).toString()).toBe('PNG')
    expect(host.purgeConversation).toHaveBeenCalledWith(record.conversationId)
    expect(getConversation(record.conversationId)).toBeUndefined()
    // The bot's conversation and its folder stay, with what the run wrote there.
    expect(getConversation(primary.id)).toBeDefined()
    await access(path.join(primary.cwd, 'prices.csv'))
    expect(runs.get(runId)).toBeUndefined()
    expect(queue.list().filter((item) => item.input.run?.id === runId)).toEqual([])
    await expect(runtime.runTranscript(runId, null, 10)).rejects.toMatchObject({ status: 404 })
    await expect(runtime.deleteRun(runId)).rejects.toMatchObject({ status: 404 })
  })

  it("never lets a run's conversation change the folder it works in", async () => {
    const { runtime, runs } = await bot()
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    const record = runs.get(runId)!
    expect(() =>
      getDb().prepare('UPDATE conversations SET folder_owner_id = ? WHERE id = ?').run(null, record.conversationId)
    ).toThrow(/immutable/)
  })
})

const peerInput = (threadId: string, text = 'Release 4.2 passed: 412 of 415 tests.') => ({
  idempotencyKey: randomUUID(),
  source: 'peer' as const,
  text,
  peer: { botId: 'nina', name: 'Nina' },
  thread: { id: threadId, title: 'Release 4.2' },
  attachments: [],
})

describe('threads with other bots in conversations of their own', () => {
  it("opens a thread's conversation for another bot's first message, and keeps its items as the thread's", async () => {
    const { runtime, primary, runs, queue } = await bot()
    const threadId = randomUUID()
    const receipt = await runtime.input(peerInput(threadId, 'Can you check the 4.2 regression?'))
    const record = runs.thread(threadId)!
    expect(record).toMatchObject({ peerBotId: 'nina', peerName: 'Nina', title: 'Release 4.2', origin: 'peer' })
    expect(getConversation(record.conversationId)).toMatchObject({ cwd: primary.cwd, folderOwnerId: primary.id })
    expect(runtime.ownsConversation(record.conversationId)).toBe(true)
    expect(inputRunId(queue.list().at(-1)!)).toBe(threadId)
    expect((await runtime.transcript(null, 50)).items).toEqual([])
    expect((await runtime.runTranscript(threadId, null, 50)).items).toEqual([
      expect.objectContaining({ id: receipt.itemId, source: 'peer', queued: true }),
    ])
    // The bot reads it as a conversation of its own, whose replies stay in it.
    const prompt = promptForInput(peerInput(threadId))
    expect(prompt).toContain('a conversation of its own')
    expect(prompt).toContain('bot_peers_send to nina')
    await runtime.input(peerInput(threadId, 'One more thing'))
    expect(runs.list()).toHaveLength(1)
    // The owner writes only in a thread that is here; a thread is never a run, nor a run a thread.
    await expect(
      runtime.input({
        idempotencyKey: randomUUID(),
        source: 'owner',
        text: 'Hi',
        thread: { id: randomUUID(), title: 'x' },
        attachments: [],
      })
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      runtime.input({
        idempotencyKey: randomUUID(),
        source: 'owner',
        text: 'Hi',
        run: { id: threadId },
        attachments: [],
      })
    ).rejects.toMatchObject({ status: 400 })
    const runId = randomUUID()
    await runtime.input(routineInput(runId))
    await expect(runtime.input(peerInput(runId))).rejects.toMatchObject({ status: 400 })
  })

  it("keeps a queued message of a thread in the thread's conversation after a restart", async () => {
    const { runtime, queue } = await bot()
    const threadId = randomUUID()
    await runtime.input(peerInput(threadId))
    await queue.idle()
    // A restart reads the queue from its file again.
    const reloaded = new InstanceInputQueue(path.join(dir, 'inputs.json'), path.join(dir, 'attachments'))
    await reloaded.load()
    const [item] = reloaded.list().filter((entry) => entry.input.source === 'peer')
    expect(inputRunId(item)).toBe(threadId)
    expect(item.input.thread).toEqual({ id: threadId, title: 'Release 4.2' })
    expect(promptForInput(item.input)).toContain('a conversation of its own')
  })

  it('tells the first answer of a thread the bot opened what it had sent and why, once', async () => {
    const { runtime, runs, queue } = await bot()
    const threadId = randomUUID()
    await runtime.recordThread(
      {
        threadId,
        peerBotId: 'nina',
        peerName: 'Nina',
        title: 'Release 4.2',
        origin: 'primary',
        opening: { sent: 'Did 4.2 pass?', ask: 'Ask Nina whether 4.2 passed' },
      },
      {
        kind: 'peer_out',
        id: 'thread-open:' + threadId,
        at: new Date().toISOString(),
        to: { botId: 'nina', name: 'Nina' },
        text: 'Did 4.2 pass?',
        delivered: true,
        thread: { id: threadId },
      }
    )
    // The thread's conversation shows first the message that opened it.
    expect((await runtime.runTranscript(threadId, null, 50)).items).toEqual([
      expect.objectContaining({ kind: 'peer_out', text: 'Did 4.2 pass?' }),
    ])
    await runtime.input(peerInput(threadId))
    await runtime.input(peerInput(threadId, 'Anything else?'))
    const [first, second] = queue.list().filter((item) => item.input.thread?.id === threadId)
    expect(first.input.thread?.context).toBe(
      openingContext({ origin: 'primary', opening: { sent: 'Did 4.2 pass?', ask: 'Ask Nina whether 4.2 passed' } })
    )
    expect(first.input.thread?.context).toContain('bot_peers_report')
    expect(promptForInput(first.input)).toMatch(/^You opened this conversation from another one/)
    expect(second.input.thread?.context).toBeUndefined()
    expect(runs.thread(threadId)?.opening).toBeNull()
    // One opened from another side conversation has no answer to bring back to the owner's.
    expect(openingContext({ origin: 'side', opening: { sent: 'Hi', ask: null } })).not.toContain('bot_peers_report')
  })

  it("runs a thread's turn in its conversation, and deletes it keeping its files under the other bot's name", async () => {
    const { runtime, primary, runs, published, host } = await bot()
    const threadId = randomUUID()
    await runtime.input(peerInput(threadId))
    const { conversations } = answer('Thanks, noted.', { image: true })
    vi.spyOn(chatService, 'acquireChatConversationSlot').mockResolvedValue({
      release: () => {},
      operation: {},
    } as never)
    await turn(runtime)
    const record = runs.thread(threadId)!
    expect(conversations).toEqual([record.conversationId])
    expect(published.find((event) => event.type === 'turn.finished')).toMatchObject({
      runId: threadId,
      outcome: 'completed',
    })
    expect(runtime.foregroundConversationId).toBe(primary.id)
    const deleted = await runtime.deleteRun(threadId)
    expect(deleted.kept.folder).toBe(laneKeptFolder(record))
    expect(deleted.kept.folder).toMatch(/^bots\/nina\//)
    expect(host.purgeConversation).toHaveBeenCalledWith(record.conversationId)
    expect(runs.get(threadId)).toBeUndefined()
  })

  it('keeps runs and threads in lists of their own, both read for a purge', async () => {
    const { runtime, runs } = await bot()
    const runId = randomUUID()
    const threadId = randomUUID()
    await runtime.input(routineInput(runId))
    await runtime.input(peerInput(threadId))
    await runs.idle()
    const runsFile = JSON.parse(await readFile(path.join(dir, 'runs.json'), 'utf8'))
    const threadsFile = JSON.parse(await readFile(path.join(dir, 'threads.json'), 'utf8'))
    expect(runsFile.runs.map((run: { runId: string }) => run.runId)).toEqual([runId])
    expect(threadsFile.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual([threadId])
    expect(
      (
        await readRunConversationIds({ runs: path.join(dir, 'runs.json'), threads: path.join(dir, 'threads.json') })
      ).sort()
    ).toEqual([runs.get(runId)!.conversationId, runs.get(threadId)!.conversationId].sort())
    const reloaded = new BotRunConversations({
      file: path.join(dir, 'runs.json'),
      threadsFile: path.join(dir, 'threads.json'),
      folder: path.join(dir, 'runs'),
      queue: runtime.queue,
      images: runtime.images,
      publish: () => {},
      turnInputId: () => null,
      changed: () => {},
    })
    await reloaded.load()
    expect(reloaded.routine(runId)).toMatchObject({ kind: 'routine', routineId: 'post' })
    expect(reloaded.thread(threadId)).toMatchObject({ kind: 'thread', peerBotId: 'nina' })
    // A bot without the threads' list keeps no threads.
    const older = new BotRunConversations({
      file: path.join(dir, 'runs.json'),
      folder: path.join(dir, 'runs'),
      queue: runtime.queue,
      images: runtime.images,
      publish: () => {},
      turnInputId: () => null,
      changed: () => {},
    })
    await older.load()
    expect(older.list().map((record) => record.runId)).toEqual([runId])
  })

  it("brings a thread's answer back to the bot's own conversation through its always-on memory", async () => {
    let now = Date.parse('2026-10-18T10:00:00.000Z')
    const reports = new ThreadReports(path.join(dir, 'reports.json'), () => now)
    expect(await reports.section()).toBeNull()
    await reports.add({ threadId: 't1', peerName: 'Nina', title: 'Release 4.2', text: 'Passed.' })
    await reports.add({ threadId: 't1', peerName: 'Nina', title: 'Release 4.2', text: 'Passed: 412 of 415.' })
    const section = await reports.section()
    expect(section).toMatchObject({ key: 'peer-reports' })
    // A thread's latest answer replaces its earlier one.
    expect(section?.entries).toEqual([
      expect.objectContaining({ text: 'Passed: 412 of 415.', meta: expect.stringContaining('Nina · Release 4.2') }),
    ])
    for (let i = 0; i < THREAD_REPORT_LIMITS.keep + 2; i++)
      await reports.add({ threadId: 'x' + i, peerName: 'Gamma', title: 'Topic', text: 'Answer ' + i })
    expect(await reports.list()).toHaveLength(THREAD_REPORT_LIMITS.keep)
    // Read again from its file, as after a restart; a week later, none is left.
    const reread = new ThreadReports(path.join(dir, 'reports.json'), () => now)
    expect((await reread.list()).at(-1)).toMatchObject({ threadId: 'x11' })
    now += THREAD_REPORT_LIMITS.maxAgeMs + 1
    expect(await reread.section()).toBeNull()
  })

  it("reports only from a thread's conversation", async () => {
    const { runtime } = await bot()
    const threadId = randomUUID()
    await runtime.input(peerInput(threadId))
    await runtime.reportThread(threadId, 'Nina says it passed.')
    expect(await runtime.threadReports.list()).toEqual([
      expect.objectContaining({ threadId, peerName: 'Nina', title: 'Release 4.2', text: 'Nina says it passed.' }),
    ])
    await expect(runtime.reportThread(randomUUID(), 'No')).rejects.toThrow('not here')
  })
})
