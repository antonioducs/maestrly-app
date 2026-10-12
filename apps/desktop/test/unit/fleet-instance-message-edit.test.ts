import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetInstanceEvent, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getChatMessage, listChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import type { MessagePart } from '../../src/shared/chat'
import { InstanceInputQueue } from '../../src/main/fleet/instance/queue'
import { InstanceTranscriptExtras } from '../../src/main/fleet/instance/transcript'
import { FleetImageStore } from '../../src/main/fleet/instance/images'
import { LiveTranscript } from '../../src/main/fleet/instance/live-transcript'
import { InstanceEvents } from '../../src/main/fleet/instance/server'
import { BotRuntime, queuedAttachment } from '../../src/main/fleet/instance/runtime'

const NO_HOLD = { state: 'none', reason: null, since: null, interruptedTurn: false } as const
const iso = (ms: number) => new Date(ms).toISOString()

let dir = ''
beforeEach(async () => {
  freshDb()
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-message-edit-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

/**
 * A bot runtime over a real queue, transcript extras and live transcript of one conversation; its turns, status and
 * usage are stubs, so an edit is seen exactly as it leaves the bot.
 */
function bot(conversationId = makeConversation(makeWorkspace().id).id) {
  const queueFile = path.join(dir, 'inputs.json')
  const extrasFile = path.join(dir, 'transcript.json')
  const events = new InstanceEvents()
  const published: FleetInstanceEvent[] = []
  events.subscribe((event) => published.push(event))
  const queue = new InstanceInputQueue(queueFile, path.join(dir, 'attachments'))
  const extras = new InstanceTranscriptExtras(extrasFile, () => {})
  const live = new LiveTranscript({
    conversationId: () => conversationId,
    queue,
    extras,
    images: new FleetImageStore(path.join(dir, 'images')),
    publish: (item) => events.publish({ type: 'transcript.upsert', item, botId: 'alpha' }),
  })
  const runtime = Object.create(BotRuntime.prototype) as BotRuntime
  const tick = vi.fn(async () => {})
  Object.assign(runtime, {
    botId: 'alpha',
    disposed: false,
    stored: { primaryConversationId: conversationId },
    events,
    queue,
    extras,
    live,
    holdManager: { state: NO_HOLD },
    editing: false,
    turning: false,
    manualCompacting: false,
    pending: () => [],
    changed: vi.fn(),
    refreshUsage: vi.fn(async () => {}),
    tick,
  })
  return { runtime, conversationId, queue, extras, live, events, published, tick, queueFile, extrasFile }
}

type Bot = ReturnType<typeof bot>

function message(
  conversationId: string,
  role: 'user' | 'assistant',
  createdAt: number,
  text: string,
  extra: MessagePart[] = []
): string {
  const id = randomUUID()
  upsertChatMessage({
    id,
    conversationId,
    role,
    createdAt,
    parts: [{ type: 'text', id: randomUUID(), text }, ...extra],
    ...(role === 'assistant' ? { finishReason: 'stop' } : {}),
  })
  return id
}

/** An input the bot took and answered: its native message, mapped and settled, then the bot's reply. */
async function answered(
  target: Bot,
  text: string,
  at: number,
  options: { source?: 'owner' | 'routine'; files?: MessagePart[] } = {}
) {
  const source = options.source ?? 'owner'
  const receipt = await target.queue.enqueue({
    idempotencyKey: randomUUID(),
    text,
    source,
    ...(source === 'routine' ? { routine: { id: 'routine-1', title: 'Daily' } } : {}),
  })
  await target.queue.markStarted(receipt.inputId)
  const prompt = target.queue.all().find((item) => item.id === receipt.inputId)!
  const nativeId = message(
    target.conversationId,
    'user',
    at,
    source === 'owner' ? text : `Scheduled routine "Daily". Do this now:\n\n${text}`,
    options.files
  )
  await target.queue.mapNativeMessage(receipt.inputId, nativeId)
  const replyId = message(target.conversationId, 'assistant', at + 10, 'Reply to ' + text)
  return { inputId: receipt.inputId, itemId: prompt.itemId, nativeId, replyId }
}

const edit = (text: string) => ({ text, idempotencyKey: randomUUID() })

describe('editing the owner last message', () => {
  it('cuts the conversation, its notes and settled input, and queues the edit with its attachments', async () => {
    const target = bot()
    const start = Date.UTC(2026, 9, 10, 12)
    const first = await answered(target, 'First task', start)
    const notes: MessagePart[] = [
      { type: 'file', id: randomUUID(), name: 'notes.txt', mediaType: 'text/plain', kind: 'text', data: 'São Paulo' },
    ]
    const last = await answered(target, 'Second task', start + 60_000, { files: notes })
    const system = (id: string, at: number, code: string) => ({ kind: 'system', id, at: iso(at), code, text: null })
    const kept = { ...system('system:kept', start + 30_000, 'restarted'), durationMs: null }
    const cutSystem = { ...system('system:cut', start + 61_000, 'turn_failed'), durationMs: null }
    const cutPermission = {
      kind: 'permission',
      id: 'perm:req-1',
      at: iso(start + 60_500),
      requestId: 'req-1',
      title: 'Run a command',
      detail: null,
      tool: null,
      state: 'approved',
      resolvedAt: iso(start + 60_600),
    }
    // An answered question stands in its tool call's place: the reply's id and time, stamped here before the message.
    const cutQuestion = {
      kind: 'question',
      id: `${last.replyId}:0`,
      at: iso(start + 59_990),
      toolCallId: 'call-1',
      questions: [{ question: 'Which one?', header: null, options: [], multiSelect: false }],
      state: 'answered',
      answers: [['A']],
    }
    for (const item of [kept, cutPermission, cutSystem, cutQuestion])
      await target.extras.upsert(item as FleetTranscriptItem)
    target.live.anchor()

    // A turn that could not start earlier left a delay before the next attempt.
    Object.assign(target.runtime, { retryAt: Date.now() + 60_000 })
    const request = edit('Second task, done differently')
    const receipt = await target.runtime.editInput(last.inputId, request)

    expect(receipt).toMatchObject({ queued: true, itemId: 'input:' + receipt.inputId })
    // The conversation keeps what came before the edited message only.
    expect(listChatMessages(target.conversationId).map((item) => item.id)).toEqual([first.nativeId, first.replyId])
    expect(getChatMessage(target.conversationId, last.nativeId)).toBeNull()
    // The edit waits in the queue as an owner message, with the attachment the original had.
    const queued = target.queue.list()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ id: receipt.inputId, input: { source: 'owner', text: request.text } })
    expect(queued[0].attachments).toMatchObject([{ kind: 'text', name: 'notes.txt', mediaType: 'text/plain' }])
    expect(await target.queue.readAttachments(queued[0])).toMatchObject([{ kind: 'text', data: 'São Paulo' }])
    // Notes and interactions of the cut turn leave the transcript, in memory and on disk.
    expect(target.extras.list().map((item) => item.id)).toEqual(['system:kept'])
    const reloadedExtras = new InstanceTranscriptExtras(target.extrasFile, () => {})
    await reloadedExtras.load()
    expect(reloadedExtras.list().map((item) => item.id)).toEqual(['system:kept'])
    // The edited input leaves the settled log; the first one stays.
    const reloadedQueue = new InstanceInputQueue(target.queueFile, path.join(dir, 'attachments'))
    await reloadedQueue.load()
    expect(reloadedQueue.all().map((item) => item.id)).toEqual([first.inputId, receipt.inputId])
    expect(reloadedQueue.byItemId(last.itemId)).toBeUndefined()
    // Readers load the transcript again, and the next turn is asked for.
    expect(target.published.filter((event) => event.type === 'reset')).toHaveLength(1)
    expect(target.tick).toHaveBeenCalledOnce()
    // The owner wrote again: the edited turn is tried at once.
    expect((target.runtime as unknown as { retryAt: number }).retryAt).toBe(0)
    const page = await target.runtime.transcript(null, 50)
    expect(page.items.map((item) => item.id)).toEqual([
      first.itemId,
      `${first.replyId}:0`,
      'system:kept',
      receipt.itemId,
    ])
  })

  it('reads the new turn from the seqs the cut freed', async () => {
    const target = bot()
    const start = Date.UTC(2026, 9, 10, 12)
    await answered(target, 'First task', start)
    const last = await answered(target, 'Second task', start + 60_000)
    // A long answer: the transcript reads only what comes after the newest message it saw.
    for (let index = 0; index < 5; index++)
      message(target.conversationId, 'assistant', start + 61_000 + index, 'More ' + index)
    target.live.anchor()

    const receipt = await target.runtime.editInput(last.inputId, edit('Second task, again'))

    // The turn the queue starts writes its messages with the seqs the cut freed, below the floor seen before.
    await target.queue.markStarted(receipt.inputId)
    target.live.turnStarted()
    const nativeId = message(target.conversationId, 'user', start + 120_000, 'Second task, again')
    await target.queue.mapNativeMessage(receipt.inputId, nativeId)
    const replyId = message(target.conversationId, 'assistant', start + 120_010, 'A new reply')
    target.published.length = 0
    await target.live.refresh()
    const upserted = target.published.flatMap((event) => (event.type === 'transcript.upsert' ? [event.item] : []))
    expect(upserted.map((item) => item.id)).toEqual([receipt.itemId, `${replyId}:0`])
    expect(upserted[1]).toMatchObject({ kind: 'assistant', text: 'A new reply' })
  })

  it('answers a retried edit with its receipt, without cutting again', async () => {
    const target = bot()
    const last = await answered(target, 'Only task', Date.UTC(2026, 9, 10, 12))
    const request = edit('Only task, edited')
    const receipt = await target.runtime.editInput(last.inputId, request)
    const messages = listChatMessages(target.conversationId).length
    expect(await target.runtime.editInput(last.inputId, request)).toEqual(receipt)
    expect(listChatMessages(target.conversationId)).toHaveLength(messages)
    expect(target.queue.list()).toHaveLength(1)
    expect(target.published.filter((event) => event.type === 'reset')).toHaveLength(1)
  })

  it('refuses an edit that would cut another message, or while the bot is busy', async () => {
    const target = bot()
    const start = Date.UTC(2026, 9, 10, 12)
    const owner = await answered(target, 'Owner task', start)
    const routine = await answered(target, 'Check the portal', start + 60_000, { source: 'routine' })
    const before = listChatMessages(target.conversationId).map((item) => item.id)
    const refusal = async (inputId: string, status: number) =>
      expect(target.runtime.editInput(inputId, edit('Edited'))).rejects.toMatchObject({ status })

    // A routine came after the owner's message, and a routine's message is not the owner's.
    await refusal(owner.inputId, 409)
    await refusal(routine.inputId, 409)
    await refusal(randomUUID(), 404)

    const latest = await answered(target, 'Latest task', start + 120_000)
    for (const busy of [{ turning: true }, { manualCompacting: true }, { editing: true }]) {
      Object.assign(target.runtime, busy)
      await refusal(latest.inputId, 409)
      Object.assign(target.runtime, { turning: false, manualCompacting: false, editing: false })
    }
    Object.assign(target.runtime, { holdManager: { state: { ...NO_HOLD, state: 'held', reason: 'paused' } } })
    await refusal(latest.inputId, 409)
    Object.assign(target.runtime, { holdManager: { state: NO_HOLD } })
    Object.assign(target.runtime, { pending: () => [{ kind: 'help', id: 'h', at: iso(start), reason: 'x' }] })
    await refusal(latest.inputId, 409)
    Object.assign(target.runtime, { pending: () => [] })
    const waiting = await target.queue.enqueue({ idempotencyKey: randomUUID(), text: 'Next', source: 'owner' })
    await refusal(latest.inputId, 409)
    await target.queue.delete(waiting.inputId)
    // Without text, an edit needs the attachments the message had.
    await expect(target.runtime.editInput(latest.inputId, edit('  '))).rejects.toMatchObject({ status: 400 })

    expect(listChatMessages(target.conversationId).map((item) => item.id)).toEqual([
      ...before,
      latest.nativeId,
      latest.replyId,
    ])
    expect(target.published.filter((event) => event.type === 'reset')).toEqual([])
    expect(target.tick).not.toHaveBeenCalled()
    // Once idle with nothing waiting, the latest owner message is edited.
    await expect(target.runtime.editInput(latest.inputId, edit('Latest task, edited'))).resolves.toMatchObject({
      queued: true,
    })
  })
})

describe('attachments an edit keeps', () => {
  it('queues readable images, documents and text again, and drops what is no longer valid', () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
    expect(queuedAttachment({ name: 'shot.png', mediaType: 'image/png', kind: 'image', bytes: png })).toEqual({
      kind: 'image',
      name: 'shot.png',
      mediaType: 'image/png',
      dataBase64: Buffer.from(png).toString('base64'),
    })
    const pdf = new Uint8Array(Buffer.from('%PDF-1.7'))
    expect(queuedAttachment({ name: 'a.pdf', mediaType: 'application/pdf', kind: 'pdf', bytes: pdf })?.kind).toBe('pdf')
    expect(queuedAttachment({ name: 'n.txt', mediaType: 'text/plain', kind: 'text', data: 'olá' })).toMatchObject({
      kind: 'text',
      dataBase64: Buffer.from('olá').toString('base64'),
    })
    // Bytes gone, bytes that no longer match their type, and a type a bot does not take.
    expect(queuedAttachment({ name: 'gone.png', mediaType: 'image/png', kind: 'image' })).toBeNull()
    expect(queuedAttachment({ name: 'bad.png', mediaType: 'image/png', kind: 'image', bytes: pdf })).toBeNull()
    expect(queuedAttachment({ name: 'x.bmp', mediaType: 'image/bmp', kind: 'image', bytes: png })).toBeNull()
  })
})
