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
const { InstanceInputQueue, conversationQueue, promptForInput, RUN_CONVERSATION_NOTE } = await import(
  '../../src/main/fleet/instance/queue'
)
const { InstanceTranscriptExtras } = await import('../../src/main/fleet/instance/transcript')
const { FleetImageStore } = await import('../../src/main/fleet/instance/images')
const { LiveTranscript } = await import('../../src/main/fleet/instance/live-transcript')
const { InstanceEvents, InstanceHttpError } = await import('../../src/main/fleet/instance/server')
const { InstanceHelpStore } = await import('../../src/main/fleet/instance/help')
const { InstanceHoldManager } = await import('../../src/main/fleet/instance/gate')
const { BotRunConversations } = await import('../../src/main/fleet/instance/routine-runs')
const { runKeptFolder } = await import('../../src/main/fleet/instance/run-files')
const { BotRuntime } = await import('../../src/main/fleet/instance/runtime')
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
  let turnInputId: () => string | null = () => null
  const runs = new BotRunConversations({
    file: path.join(dir, 'runs.json'),
    folder: path.join(dir, 'runs'),
    queue,
    images,
    publish: (runId, item) => publish({ type: 'transcript.upsert', item, runId }),
    turnInputId: () => turnInputId(),
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
    }),
    holdManager: new InstanceHoldManager(),
    ownerMemory: { coreSections: async () => [], writer: () => ({}) },
    accountOptions: [{ providerId: 'p', modelId: 'm' }],
    compactionProblem: null,
    manualCompacting: false,
    editing: false,
    turning: false,
    retryAt: 0,
    startFailures: 0,
    reportedStartFailure: null,
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
  turnInputId = () => (runtime as unknown as { turnInputId: string | null }).turnInputId
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
    let active: string | null = null
    vi.spyOn(chatService, 'acquireChatConversationSlot').mockImplementation(async () => {
      during = runtime.currentInput()
      active = runtime.activeConversationId
      return { release: () => {}, operation: {} } as never
    })
    await turn(runtime)
    const record = runs.get(runId)!
    expect(conversations).toEqual([record.conversationId])
    expect(active).toBe(record.conversationId)
    expect(during).toMatchObject({ source: 'routine', routine: { runId }, run: { id: runId } })
    const finished = published.find((event) => event.type === 'turn.finished')
    expect(finished).toMatchObject({ runId, outcome: 'completed', text: 'Posted.', media: { images: 1 } })
    expect(host.closeConversation).toHaveBeenCalledWith(record.conversationId)
    expect(runtime.activeConversationId).toBe(primary.id)
    // The prompt says the conversation is the run's own and asks whether it found anything new.
    expect(promptForInput(routineInput(runId))).toContain(RUN_CONVERSATION_NOTE)
    expect(promptForInput(routineInput(runId))).toContain('nothing_new')
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
      during = runtime.currentInput()
      return { release: () => {}, operation: {} } as never
    })
    await turn(runtime)
    expect(conversations).toEqual([runs.get(runId)!.conversationId])
    // The routine's metadata stays with an owner's change, so the run's report can be updated.
    expect(during).toMatchObject({ source: 'owner', routine: { id: 'post', runId }, run: { id: runId } })
    expect(runtime.currentInput()).toBeNull()
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
    const record = runs.get(runId)!
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
