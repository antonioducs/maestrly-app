import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import * as chatStore from '../../src/main/chat/chat-store'
import {
  chatSeqAtTime,
  deleteChatMessage,
  findLatestChatMessage,
  getChatMessage,
  latestPortableCompactionMessage,
  listChatMessages,
  upsertChatMessage,
  type StoredChatMessage,
} from '../../src/main/chat/chat-store'
import type { MessagePart } from '../../src/shared/chat'
import { InstanceInputQueue, type QueuedInput } from '../../src/main/fleet/instance/queue'
import { InstanceTranscriptExtras, projectChatMessages, transcriptPage } from '../../src/main/fleet/instance/transcript'
import { FleetImageStore, imageId } from '../../src/main/fleet/instance/images'
import { LiveTranscript } from '../../src/main/fleet/instance/live-transcript'

let dir: string
beforeEach(async () => {
  freshDb()
  dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-live-transcript-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  await rm(dir, { recursive: true, force: true })
})

function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const iso = (ms: number) => new Date(ms).toISOString()
const question = () => ({
  question: 'Which one?',
  header: 'Pick',
  options: [
    { label: 'A', description: null },
    { label: 'B', description: null },
  ],
  multiSelect: false,
})

/**
 * A bot conversation with what makes paging subtle: assistant rows stamped before their user rows (by a few
 * milliseconds, once by two minutes), messages sharing a time, linked and still-unmapped inputs, inputs still queued,
 * interaction items, a native question an interaction item stands for, internal messages and compaction markers.
 */
function generate(conversationId: string, seed: number, turns: number) {
  const random = prng(seed)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]
  let clock = Date.UTC(2026, 8, 1, 12)
  const records: QueuedInput[] = []
  const extras: FleetTranscriptItem[] = []
  const questions: string[] = []
  let lastUser = { id: '', text: '', at: 0 }
  for (let turn = 0; turn < turns; turn++) {
    const shared = random() < 0.08
    clock += shared ? 0 : 1 + Math.floor(random() * 120_000)
    const userAt = clock
    const text = `Task ${turn} ${pick(['check prices', 'open the portal', 'summarize the week'])}`
    const imageOnly = random() < 0.08
    const userParts: MessagePart[] = imageOnly ? [] : [{ type: 'text', id: randomUUID(), text }]
    if (imageOnly || random() < 0.1)
      userParts.push({
        type: 'file',
        id: randomUUID(),
        name: 'shot.png',
        mediaType: 'image/png',
        kind: 'image',
        artifactId: randomUUID(),
        byteSize: 1_200,
      })
    const userId = randomUUID()
    upsertChatMessage({ id: userId, conversationId, role: 'user', createdAt: userAt, parts: userParts })
    const last = turn === turns - 1
    if (!imageOnly && !last && random() < 0.6) {
      const id = randomUUID()
      const source = pick(['owner', 'routine', 'peer'] as const)
      records.push({
        id,
        at: iso(userAt - 2_000),
        input: {
          idempotencyKey: randomUUID(),
          text: 'Owner said ' + turn,
          source,
          ...(source === 'routine' ? { routine: { id: 'routine-1', title: 'Daily' } } : {}),
          ...(source === 'peer' ? { peer: { botId: 'dev', name: 'Dev' } } : {}),
        },
        attachments: [],
        itemId: 'input:' + id,
        started: true,
        nativeMessageId: userId,
      })
    }
    if (!imageOnly) lastUser = { id: userId, text, at: userAt }
    const lag = turn === Math.floor(turns / 2) ? 120_000 : random() < 0.5 ? Math.floor(random() * 40) : 0
    const assistantAt = userAt - lag
    const parts: MessagePart[] = []
    const steps = Math.floor(random() * 7)
    for (let step = 0; step < steps; step++) {
      const kind = random()
      const toolCallId = 'call_' + randomUUID()
      if (kind < 0.2) parts.push({ type: 'reasoning', id: randomUUID(), text: 'Thinking ' + step })
      else if (kind < 0.55) {
        parts.push({
          type: 'tool',
          id: toolCallId,
          toolCallId,
          toolName: pick(['bash', 'browser_navigate', 'computer_click']),
          input: { command: 'ls ' + step },
          state: pick([
            { status: 'completed' as const, output: { text: 'ok ' + step } },
            { status: 'error' as const, error: 'failed' },
            { status: 'running' as const },
          ]),
        })
        if (random() < 0.25)
          parts.push({
            type: 'generated-image',
            id: randomUUID(),
            artifactId: randomUUID(),
            name: 'chart.png',
            mediaType: 'image/png',
            byteSize: 900,
          })
      } else if (kind < 0.65) {
        questions.push(toolCallId)
        parts.push({
          type: 'tool',
          id: toolCallId,
          toolCallId,
          toolName: 'ask_question',
          input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] },
          state: pick([
            { status: 'completed' as const, output: { text: 'A' } },
            { status: 'denied' as const },
            { status: 'running' as const },
          ]),
        })
      } else if (kind < 0.7)
        parts.push({
          type: 'tool',
          id: toolCallId,
          toolCallId,
          toolName: 'request_owner_help',
          input: { reason: 'Login' },
          state: { status: 'running' },
        })
      else if (kind < 0.78)
        parts.push({
          type: 'tool',
          id: toolCallId,
          toolCallId,
          toolName: 'bot_peers_send',
          input: { to: 'dev', text: 'Hello ' + step, name: 'Dev' },
          state: { status: 'completed', output: { text: JSON.stringify({ delivered: true, name: 'Dev' }) } },
        })
      else if (kind < 0.85)
        parts.push({
          type: 'compaction',
          id: randomUUID(),
          text: 'Summary of turn ' + turn,
          origin: 'prepared',
          strategy: pick(['summary', 'codex-native'] as const),
        })
      else parts.push({ type: 'text', id: randomUUID(), text: 'Step ' + step })
    }
    parts.push({ type: 'text', id: randomUUID(), text: 'Done ' + turn })
    upsertChatMessage({
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      createdAt: assistantAt,
      parts,
      ...(!last || random() < 0.5 ? { finishReason: 'stop' } : {}),
      ...(random() < 0.05 ? { internal: true } : {}),
    })
    if (random() < 0.15)
      extras.push({
        kind: 'system',
        id: 'system:' + randomUUID(),
        at: iso(clock + 5),
        code: 'restarted',
        text: null,
        durationMs: null,
      })
    if (random() < 0.15) {
      const requestId = randomUUID()
      extras.push({
        kind: 'permission',
        id: 'perm:' + requestId,
        at: iso(assistantAt + 3),
        requestId,
        title: 'Run ls',
        detail: null,
        tool: null,
        state: 'approved',
        resolvedAt: iso(assistantAt + 4),
      })
    }
    if (random() < 0.08) {
      const helpId = randomUUID()
      extras.push({
        kind: 'help',
        id: 'help:' + helpId,
        helpId,
        at: iso(clock + 1),
        reason: 'Login',
        state: 'resolved',
        resolvedAt: iso(clock + 2),
        note: null,
      })
    }
  }
  const superseded = questions[Math.floor(questions.length / 2)] ?? null
  if (superseded)
    extras.push({
      kind: 'question',
      id: 'question:' + superseded,
      at: iso(clock),
      toolCallId: superseded,
      questions: [question()],
      state: 'answered',
      answers: [['A']],
    })
  // Started, not mapped yet: the projection links it to the newest user message by text.
  const unmapped = randomUUID()
  records.push({
    id: unmapped,
    at: iso(lastUser.at - 500),
    input: { idempotencyKey: randomUUID(), text: lastUser.text, source: 'owner' },
    attachments: [],
    itemId: 'input:' + unmapped,
    started: true,
  })
  for (let index = 0; index < 3; index++) {
    const id = randomUUID()
    records.push({
      id,
      at: iso(clock - 60_000 + index * 45_000),
      input: { idempotencyKey: randomUUID(), text: 'Later ' + index, source: 'owner' },
      attachments: [],
      itemId: 'input:' + id,
      started: false,
    })
  }
  return { records, extras, questions, superseded }
}

async function fixture(conversationId: string, data: { records?: QueuedInput[]; extras?: FleetTranscriptItem[] } = {}) {
  const folder = await mkdtemp(path.join(dir, 'bot-'))
  const inputs = path.join(folder, 'inputs.json')
  const transcript = path.join(folder, 'transcript.json')
  if (data.records) await writeFile(inputs, JSON.stringify({ items: data.records }))
  if (data.extras) await writeFile(transcript, JSON.stringify(data.extras))
  const queue = new InstanceInputQueue(inputs, path.join(folder, 'attachments'))
  await queue.load()
  const extras = new InstanceTranscriptExtras(transcript, () => {})
  await extras.load()
  const images = new FleetImageStore(path.join(folder, 'images'))
  await images.load()
  const published: FleetTranscriptItem[] = []
  const live = new LiveTranscript({
    conversationId: () => conversationId,
    queue,
    extras,
    images,
    publish: (item) => published.push(item),
  })
  /** The page the runtime cut from the whole transcript before: every message projected and sorted. */
  const reference = (before: string | null, limit: number) => {
    const native = projectChatMessages(listChatMessages(conversationId), queue.all(), (part) => images.toolRefs(part))
    const queued: FleetTranscriptItem[] = queue.list().map((entry) => ({
      kind: 'user',
      id: entry.itemId,
      at: entry.at,
      text: entry.input.text,
      source: entry.input.source,
      routine: entry.input.routine,
      peer: entry.input.peer,
      queued: true,
      memories: [],
      images: queue.refs(entry),
    }))
    const extra = extras.list()
    const questions = new Set(extra.flatMap((item) => (item.kind === 'question' ? [item.toolCallId] : [])))
    return transcriptPage(
      [...native.filter((item) => item.kind !== 'question' || !questions.has(item.toolCallId)), ...queued, ...extra],
      before,
      limit
    )
  }
  return { queue, extras, images, live, published, reference }
}
const newConversation = () => makeConversation(makeWorkspace().id).id

describe('bot transcript pages', () => {
  it('cuts every page the whole transcript would, from the newest back to the first, for every page size', async () => {
    for (const seed of [11, 12, 13]) {
      const conversationId = newConversation()
      const data = generate(conversationId, seed, 70)
      const { live, reference } = await fixture(conversationId, data)
      for (const limit of [1, 2, 7, 50, 200, 500]) {
        let before: string | null = null
        let pages = 0
        do {
          const expected = reference(before, limit)
          const actual = await live.page(before, limit)
          expect(actual, `seed ${seed}, limit ${limit}, before ${before}`).toEqual(expected)
          before = actual.before
          pages++
        } while (before && (limit > 2 || pages < 40))
      }
    }
  })

  it('takes any cursor the whole transcript takes, and gives the newest page for one that is gone', async () => {
    const conversationId = newConversation()
    const data = generate(conversationId, 21, 60)
    const { live, reference } = await fixture(conversationId, data)
    const everything = reference(null, 500).items.map((item) => item.id)
    const cursors = [
      ...everything.filter((_, index) => index % 3 === 0),
      'missing:3',
      'input:' + randomUUID(),
      'system:gone',
      `${randomUUID()}:0`,
      ...(data.superseded ? [data.superseded] : []),
    ]
    // A native question an interaction item stands for is not in the transcript: its id is not a cursor either.
    const native = listChatMessages(conversationId).find((message) =>
      message.parts.some((part) => part.type === 'tool' && part.toolCallId === data.superseded)
    )
    if (native) {
      const index = native.parts.findIndex((part) => part.type === 'tool' && part.toolCallId === data.superseded)
      cursors.push(`${native.id}:${index}`)
    }
    for (const cursor of cursors)
      for (const limit of [1, 5, 40]) expect(await live.page(cursor, limit), cursor).toEqual(reference(cursor, limit))
  })

  it('reads only the newest messages a page needs, however long the conversation', async () => {
    const conversationId = newConversation()
    generate(conversationId, 31, 1_500)
    const { live, reference } = await fixture(conversationId)
    const reads = vi.spyOn(chatStore, 'listChatMessagesThrough')
    const page = await live.page(null, 200)
    const rows = reads.mock.results.reduce((total, result) => total + (result.value as unknown[]).length, 0)
    expect(page).toEqual(reference(null, 200))
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThanOrEqual(300)
    reads.mockClear()
    const older = await live.page(page.before, 200)
    const olderRows = reads.mock.results.reduce((total, result) => total + (result.value as unknown[]).length, 0)
    expect(older).toEqual(reference(page.before, 200))
    expect(olderRows).toBeLessThanOrEqual(400)
  })
})

describe('bot transcript refresh', () => {
  const assistant = (conversationId: string, id: string, createdAt: number, parts: MessagePart[], done = false) =>
    upsertChatMessage({
      id,
      conversationId,
      role: 'assistant',
      createdAt,
      parts,
      ...(done ? { finishReason: 'stop' } : {}),
    })

  it('sends what a turn changes, once, and never the conversation that came before', async () => {
    const conversationId = newConversation()
    generate(conversationId, 41, 30)
    const { live, published } = await fixture(conversationId)
    live.anchor()
    await live.refresh()
    expect(published).toEqual([])
    const now = Date.UTC(2026, 9, 1)
    live.turnStarted()
    upsertChatMessage({
      id: 'user-now',
      conversationId,
      role: 'user',
      createdAt: now,
      parts: [{ type: 'text', id: 'u', text: 'Now' }],
    })
    assistant(conversationId, 'assistant-now', now + 1, [{ type: 'text', id: 't', text: 'Wor' }])
    live.touched('assistant-now')
    await live.refresh()
    const turn = () =>
      projectChatMessages(
        ['user-now', 'assistant-now'].map((id) => getChatMessage(conversationId, id)!),
        []
      )
    expect(published).toEqual(turn())
    published.length = 0
    await live.refresh()
    expect(published).toEqual([])
    assistant(conversationId, 'assistant-now', now + 1, [
      { type: 'text', id: 't', text: 'Working' },
      {
        type: 'tool',
        id: 'c1',
        toolCallId: 'c1',
        toolName: 'bash',
        input: { command: 'ls' },
        state: { status: 'running' },
      },
    ])
    live.touched('assistant-now')
    await live.refresh()
    expect(published.map((item) => item.id)).toEqual(['assistant-now:0', 'assistant-now:1'])
    published.length = 0
    assistant(
      conversationId,
      'assistant-now',
      now + 1,
      [
        { type: 'text', id: 't', text: 'Working' },
        {
          type: 'tool',
          id: 'c1',
          toolCallId: 'c1',
          toolName: 'bash',
          input: { command: 'ls' },
          state: { status: 'completed', output: { text: 'ok' } },
        },
      ],
      true
    )
    live.touched('assistant-now')
    await live.refresh()
    expect(published).toEqual(turn().filter((item) => item.id !== 'user-now:0'))
    expect(published.find((item) => item.kind === 'assistant')).toMatchObject({ streaming: false })
  })

  it('sends a prepared compaction inserted into an older message, which no event names', async () => {
    const conversationId = newConversation()
    generate(conversationId, 42, 20)
    // Plain turns after the last marker; the newest carries a native checkpoint, as a runtime's own compaction does.
    const at = Date.UTC(2026, 9, 5)
    for (let turn = 0; turn < 5; turn++)
      assistant(
        conversationId,
        'plain' + turn,
        at + turn * 1_000,
        [
          { type: 'text', id: 'a', text: 'First ' + turn },
          { type: 'text', id: 'b', text: 'Second ' + turn },
          ...(turn === 4
            ? [{ type: 'compaction' as const, id: 'native', text: '', strategy: 'codex-native' as const }]
            : []),
        ],
        true
      )
    const { live, published } = await fixture(conversationId)
    live.anchor()
    await live.refresh()
    expect(published).toEqual([])
    const older = getChatMessage(conversationId, 'plain2')!
    const marker: MessagePart = { type: 'compaction', id: 'prepared', text: 'Prepared summary', origin: 'prepared' }
    upsertChatMessage({ ...older, parts: [older.parts[0], marker, older.parts[1]] })
    await live.refresh()
    expect(published).toEqual(projectChatMessages([getChatMessage(conversationId, 'plain2')!], []))
    expect(published[1]).toMatchObject({ id: 'plain2:1', kind: 'compaction', summary: 'Prepared summary' })
    published.length = 0
    await live.refresh()
    expect(published).toEqual([])
  })

  it('reads the previous turn once more when the next one starts, for a save that came after its last event', async () => {
    const conversationId = newConversation()
    const { live, published } = await fixture(conversationId)
    live.anchor()
    const at = Date.UTC(2026, 9, 2)
    live.turnStarted()
    assistant(conversationId, 'first', at, [{ type: 'text', id: 't', text: 'Part' }])
    live.touched('first')
    await live.refresh()
    // Its final text reached the database after the last refresh of its turn.
    assistant(conversationId, 'first', at, [{ type: 'text', id: 't', text: 'Part and the rest' }], true)
    live.turnStarted()
    assistant(conversationId, 'second', at + 10_000, [{ type: 'text', id: 't', text: 'Next' }])
    live.touched('second')
    published.length = 0
    await live.refresh()
    expect(published).toMatchObject([
      { id: 'first:0', text: 'Part and the rest', streaming: false },
      { id: 'second:0', text: 'Next' },
    ])
    published.length = 0
    assistant(conversationId, 'first', at, [{ type: 'text', id: 't', text: 'Changed without an event' }], true)
    await live.refresh()
    expect(published).toEqual([])
  })

  it('does not send a native question that an interaction item stands for', async () => {
    const conversationId = newConversation()
    const { live, published, extras } = await fixture(conversationId)
    live.anchor()
    live.turnStarted()
    assistant(conversationId, 'asks', Date.UTC(2026, 9, 3), [
      {
        type: 'tool',
        id: 'q1',
        toolCallId: 'q1',
        toolName: 'ask_question',
        input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A' }] }] },
        state: { status: 'running' },
      },
      { type: 'text', id: 't', text: 'Waiting' },
    ])
    await extras.upsert({
      kind: 'question',
      id: 'question:q1',
      at: iso(Date.UTC(2026, 9, 3)),
      toolCallId: 'q1',
      questions: [question()],
      state: 'pending',
      answers: null,
    })
    live.touched('asks')
    await live.refresh()
    expect(published.map((item) => item.kind)).toEqual(['assistant'])
  })

  it('keeps the memory of sent items bounded', async () => {
    const conversationId = newConversation()
    const { live, published } = await fixture(conversationId)
    live.anchor()
    const at = Date.UTC(2026, 9, 4)
    for (let index = 0; index < 300; index++) {
      live.turnStarted()
      assistant(conversationId, 'm' + index, at + index, [{ type: 'text', id: 't', text: 'Hi ' + index }], true)
      live.touched('m' + index)
      await live.refresh()
    }
    expect(published).toHaveLength(300)
    expect((live as unknown as { emitted: Map<string, unknown> }).emitted.size).toBeLessThanOrEqual(256)
  })
})

describe('bot transcript lookups', () => {
  it('finds a tool call, an image, the messages the queue needs and a summary', async () => {
    const conversationId = newConversation()
    const data = generate(conversationId, 51, 40)
    const { live } = await fixture(conversationId, data)
    const messages = listChatMessages(conversationId)
    const toolCall = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'tool')
      .at(-1)!
    expect(live.messageWithToolCall(toolCall.type === 'tool' ? toolCall.toolCallId : '')?.parts).toContainEqual(
      toolCall
    )
    expect(live.messageWithToolCall('call_missing')).toBeNull()
    // An image of an old message, never projected here: found by searching.
    const owner = messages.find((message) => message.parts.some((part) => part.type === 'file'))!
    const file = owner.parts.find((part) => part.type === 'file')!
    expect(live.imageMessages(imageId('a', owner.id, file.id)).map((message) => message.id)).toEqual([owner.id])
    expect(live.imageMessages('a-unknown')).toEqual([])
    expect(live.imageMessages('t-tool-image')).toEqual([])
    const since = messages.at(-10)!.createdAt
    const expectedUsers = messages
      .filter((message) => message.role === 'user' && message.createdAt >= since)
      .map((message) => message.id)
    const users = live.userMessagesSince(since).map((user) => user.id)
    expect(users.filter((id) => expectedUsers.includes(id))).toEqual(expectedUsers)
    const lastAssistant = messages.filter((message) => message.role === 'assistant').at(-1)!
    expect(live.lastAssistantText(lastAssistant.id)).toBe(
      projectChatMessages([lastAssistant], [])
        .filter((item) => item.kind === 'assistant')
        .map((item) => (item.kind === 'assistant' ? item.text : ''))
        .at(-1) ?? null
    )
    expect(live.lastAssistantText(null)).toBeNull()
  })
})

describe('bounded chat reads', () => {
  it('locates a time in seq order across gaps, shared times and lagging stamps', () => {
    const conversationId = newConversation()
    expect(chatSeqAtTime(conversationId, Date.now())).toBeNull()
    const random = prng(61)
    const times: number[] = []
    let clock = 1_000_000
    for (let index = 0; index < 200; index++) {
      clock += random() < 0.1 ? 0 : Math.floor(random() * 1_000)
      const lag = random() < 0.3 ? Math.floor(random() * 50) : 0
      times.push(clock - lag)
      upsertChatMessage({ id: 'm' + index, conversationId, role: 'user', createdAt: clock - lag, parts: [] })
    }
    for (let index = 0; index < 200; index += 7) deleteChatMessage('m' + index)
    const rows = listChatMessages(conversationId).map((message) => ({
      seq: chatStore.getMessageSeq(message.id)!,
      at: message.createdAt,
    }))
    for (const time of [0, rows[0].at - 1, rows[0].at, ...rows.map((row) => row.at + 25), rows.at(-1)!.at + 5_000]) {
      const seq = chatSeqAtTime(conversationId, time)!
      const index = rows.findIndex((row) => row.seq === seq)
      if (index < 0) {
        expect(seq).toBe(rows[0].seq - 1)
        expect(rows[0].at).toBeGreaterThan(time)
      } else {
        expect(rows[index].at).toBeLessThanOrEqual(time)
        if (index + 1 < rows.length) expect(rows[index + 1].at).toBeGreaterThan(time)
      }
    }
  })

  it('finds the newest matching message, skipping rows by content and within a bound', () => {
    const conversationId = newConversation()
    for (let index = 0; index < 120; index++)
      upsertChatMessage({
        id: 'm' + index,
        conversationId,
        role: index % 2 ? 'assistant' : 'user',
        createdAt: index,
        parts: [{ type: 'text', id: 't', text: index % 10 === 0 ? 'needle ' + index : 'hay' }],
      })
    const text = (message: StoredChatMessage) => (message.parts[0]?.type === 'text' ? message.parts[0].text : '')
    expect(findLatestChatMessage(conversationId, (message) => text(message).startsWith('needle'))?.message.id).toBe(
      'm110'
    )
    expect(findLatestChatMessage(conversationId, () => true, { partsContaining: 'needle 3' })?.message.id).toBe('m30')
    expect(findLatestChatMessage(conversationId, () => true, { role: 'assistant' })?.message.id).toBe('m119')
    expect(findLatestChatMessage(conversationId, (message) => message.id === 'm5', { withinNewest: 100 })).toBeNull()
    expect(findLatestChatMessage(conversationId, (message) => message.id === 'm25', { withinNewest: 100 })?.seq).toBe(
      25
    )
    expect(latestPortableCompactionMessage(conversationId)).toBeNull()
    upsertChatMessage({
      id: 'portable',
      conversationId,
      role: 'assistant',
      createdAt: 200,
      parts: [{ type: 'compaction', id: 'c', text: 'Summary' }],
    })
    upsertChatMessage({
      id: 'native',
      conversationId,
      role: 'assistant',
      createdAt: 201,
      parts: [{ type: 'compaction', id: 'c', text: '', strategy: 'claude-native' }],
    })
    expect(latestPortableCompactionMessage(conversationId)).toMatchObject({ id: 'portable', seq: 120 })
  })
})

describe('fleet image refs', () => {
  it('finds a tool image by the chat image it came from, as the whole index did, evicted ones included', async () => {
    const root = path.join(dir, 'images')
    await mkdir(root, { recursive: true })
    const entry = (id: string, sourceIds: string[], evicted = false) => ({
      id,
      sourceIds,
      mediaType: 'image/png',
      byteSize: 10,
      name: null,
      createdAt: 1,
      ...(evicted ? { evicted: true } : {}),
    })
    const first = 't-' + 'a'.repeat(32)
    const second = 't-' + 'b'.repeat(32)
    const gone = 't-' + 'c'.repeat(32)
    await writeFile(
      path.join(root, 'index.json'),
      JSON.stringify([
        entry(first, ['tool-image:one', 'tool-image:shared']),
        entry(second, ['tool-image:two', 'tool-image:shared']),
        entry(gone, ['tool-image:old'], true),
      ])
    )
    const store = new FleetImageStore(root)
    await store.load()
    const refs = (...ids: string[]) =>
      store
        .toolRefs({
          type: 'tool',
          id: 'c',
          toolCallId: 'c',
          toolName: 'browser_screenshot',
          input: {},
          state: {
            status: 'completed',
            output: { text: '', images: ids.map((id) => ({ id, mediaType: 'image/png' })) },
          },
        })
        .map((ref) => ref.id)
    expect(refs('tool-image:one', 'tool-image:two', 'tool-image:shared', 'tool-image:old', 'tool-image:none')).toEqual([
      first,
      second,
      first,
      gone,
    ])
    // Already captured: not read from the process cache (where it no longer is) nor hashed again.
    expect(await store.capture({ id: 'tool-image:one', mediaType: 'image/png' })).toMatchObject({ id: first })
    expect(await store.capture({ id: 'tool-image:old', mediaType: 'image/png' })).toBeNull()
  })
})

describe('bot instance reads', () => {
  it('never reads a whole conversation', () => {
    const folder = new URL('../../src/main/fleet/instance/', import.meta.url)
    for (const file of readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(new URL(file, folder), 'utf8')
      expect(source, file).not.toMatch(/\blistChatMessages\(|listConversationContextMessages\(/)
    }
  })
})
