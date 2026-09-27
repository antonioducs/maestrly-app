import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { ChatMessage, MessagePart } from '../../src/shared/chat'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { InstanceInputQueue, promptForInput } from '../../src/main/fleet/instance/queue'
import { InstanceHoldManager, gateInstanceAppTool, registerInstanceHoldGate } from '../../src/main/fleet/instance/gate'
import {
  InstanceTranscriptExtras,
  projectChatMessages,
  permissionTool,
  transcriptPage,
  toolTarget,
} from '../../src/main/fleet/instance/transcript'
import {
  BotRuntime,
  canDispatch,
  continuationText,
  releaseSystemCode,
  visibleFleetModels,
  effectiveFleetSelection,
} from '../../src/main/fleet/instance/runtime'
import { botIdentityPrompt, setBotIdentity } from '../../src/main/fleet/instance/identity'
import { initialFloatingBounds } from '../../src/main/fleet/instance/window-bounds'
import { FleetImageStore, imageId, imageMediaType } from '../../src/main/fleet/instance/images'
import { clearEphemeralToolImages, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'
import { freshDb, closeDb } from '../helpers/db'

const key = () => randomUUID()
/** Queued owner images live in the folder a queue is given, never in one derived from its file. */
const attachmentsFor = (file: string) => path.join(path.dirname(file), 'attachments')
describe('fleet conversation admission', () => {
  it('holds queued work in compaction setup and reports the required model', async () => {
    freshDb()
    try {
      const runtime = Object.create(BotRuntime.prototype) as BotRuntime
      Object.assign(runtime, {
        refreshAccounts: vi.fn(async () => {}),
        pending: () => [],
        queue: { list: () => [{ id: 'input', input: { source: 'owner', text: 'Waiting' } }] },
        holdManager: { state: { state: 'none', reason: null, since: null, interruptedTurn: false } },
        events: { lastSeq: 0 },
        accountOptions: [
          {
            id: 'p::m',
            providerId: 'p',
            providerLabel: 'P',
            modelId: 'm',
            modelLabel: 'M',
            efforts: [],
            fastMode: false,
          },
        ],
        stored: null,
        compactionProblem: 'missing',
        turning: false,
        cancelling: false,
        ready: true,
        usage: null,
      })
      expect((await runtime.status()).activity).toEqual({ kind: 'setup', need: 'compaction' })
      expect((await runtime.status()).compaction).toBeNull()
    } finally {
      closeDb()
    }
  })
  it('projects prepared, immediate, manual and runtime compactions with bounded summaries', () => {
    const message: ChatMessage = {
      id: 'assistant',
      conversationId: 'conversation',
      role: 'assistant',
      createdAt: Date.parse('2026-09-25T10:00:00.000Z'),
      parts: [
        { type: 'compaction', id: 'a', text: 'prepared', strategy: 'summary', origin: 'prepared' },
        { type: 'compaction', id: 'b', text: 'immediate', strategy: 'summary' },
        { type: 'compaction', id: 'c', text: 'x'.repeat(16_001), strategy: 'summary', origin: 'manual' },
        { type: 'compaction', id: 'd', text: 'private', strategy: 'codex-native' },
      ],
    }
    expect(projectChatMessages([message])).toMatchObject([
      { kind: 'compaction', origin: 'prepared', summary: 'prepared', truncated: false },
      { kind: 'compaction', origin: 'immediate', summary: 'immediate', truncated: false },
      { kind: 'compaction', origin: 'manual', truncated: true },
      { kind: 'compaction', origin: 'runtime', summary: null, truncated: false },
    ])
  })
  it('reports the input that started the current turn and clears it when idle', async () => {
    freshDb()
    try {
      const runtime = Object.create(BotRuntime.prototype) as BotRuntime
      Object.assign(runtime, {
        refreshAccounts: vi.fn(async () => {}),
        pending: () => [],
        queue: { list: () => [] },
        holdManager: { state: { state: 'none', reason: null, since: null, interruptedTurn: false } },
        events: { lastSeq: 0 },
        accountOptions: [],
        stored: null,
        turning: true,
        turnStartedAt: '2026-09-25T10:00:00.000Z',
        turnInputId: 'queued-input',
      })
      expect((await runtime.status()).turn.inputId).toBe('queued-input')
      Object.assign(runtime, { turning: false, turnStartedAt: null, turnInputId: null })
      expect((await runtime.status()).turn.inputId).toBeNull()
    } finally {
      closeDb()
    }
  })
  it('returns a conflict before a primary conversation exists', async () => {
    const runtime = Object.create(BotRuntime.prototype) as BotRuntime
    await expect(runtime.conversationCall({ op: 'chatGetConvTools', args: [] })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
  })
})

describe('fleet model selection', () => {
  it('filters the bot hidden models and falls back when the saved model is hidden', () => {
    const models = [
      {
        id: 'p::hidden',
        providerId: 'p',
        modelId: 'hidden',
        providerLabel: 'P',
        modelLabel: 'Hidden',
        efforts: ['low'],
        fastMode: true,
      },
      {
        id: 'p::visible',
        providerId: 'p',
        modelId: 'visible',
        providerLabel: 'P',
        modelLabel: 'Visible',
        efforts: ['low'],
        fastMode: false,
      },
    ]
    const visible = visibleFleetModels(models, (provider) => (provider === 'p' ? ['hidden'] : []))
    expect(visible.map((item) => item.modelId)).toEqual(['visible'])
    expect(
      effectiveFleetSelection(
        visible,
        { providerId: 'p', modelId: 'hidden', reasoning: 'low', fastMode: true },
        { providerId: 'p', modelId: 'visible', reasoning: 'low', fastMode: true }
      )
    ).toEqual({ providerId: 'p', modelId: 'visible', reasoning: 'low', fastMode: false })
  })
})
describe('fleet image ids and signatures', () => {
  it('uses opaque stable ids and checks image bytes', () => {
    expect(imageId('a', '../message', 'part')).toMatch(/^a-[A-Za-z0-9_-]{32}$/)
    expect(imageId('a', '../message', 'part')).toBe(imageId('a', '../message', 'part'))
    expect(imageId('g', '../message', 'part')).not.toBe(imageId('a', '../message', 'part'))
    expect(imageMediaType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png')
    expect(imageMediaType(Buffer.from('not a png'))).toBeNull()
  })
  it('keeps completed tool images readable after the process cache is cleared', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-tool-images-'))
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
        'base64'
      )
      const output = mcpResultToChatToolOutput({
        content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
      })
      const image = output.images?.[0]
      expect(image).toBeDefined()
      const store = new FleetImageStore(dir)
      const ref = await store.capture(image!)
      expect(ref?.id).toMatch(/^t-[A-Za-z0-9_-]{32}$/)
      clearEphemeralToolImages()
      const reopened = new FleetImageStore(dir)
      await reopened.load()
      expect((await reopened.read(ref!.id, 'conversation', []))?.bytes).toEqual(png)
      const part = {
        type: 'tool' as const,
        id: 'tool',
        toolCallId: 'tool',
        toolName: 'computer_screenshot',
        input: {},
        state: { status: 'completed' as const, output },
      }
      expect(reopened.toolRefs(part)).toEqual([ref])
    } finally {
      clearEphemeralToolImages()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('instance configuration', () => {
  it('is inert outside exact bot mode and validates required values', () => {
    expect(parseBotInstanceConfig({ MAESTRLY_BOT_MODE: '0' })).toBeNull()
    expect(() => parseBotInstanceConfig({ MAESTRLY_BOT_MODE: '1' })).toThrow('controlToken')
    expect(() => parseBotInstanceConfig({ MAESTRLY_BOT_MODE: '1', MAESTRLY_BOT_CONTROL_TOKEN: 'short' })).toThrow(
      'controlToken'
    )
    const token = randomBytes(32).toString('base64url')
    const config = parseBotInstanceConfig({ MAESTRLY_BOT_MODE: '1', MAESTRLY_BOT_CONTROL_TOKEN: token })
    expect(config).toMatchObject({ controlHost: '0.0.0.0', controlPort: 7680 })
    expect(() =>
      parseBotInstanceConfig({
        MAESTRLY_BOT_MODE: '1',
        MAESTRLY_BOT_CONTROL_TOKEN: token,
        MAESTRLY_BOT_CONTROL_PORT: '65536',
      })
    ).toThrow('controlPort')
  })
})

describe('bot identity', () => {
  it('only appears for the primary standalone conversation in bot mode', () => {
    setBotIdentity('/bot/chat', {
      botId: 'scout',
      name: 'Scout',
      instructions: 'Track updates.',
      ceiling: 'ask',
      selection: null,
      compaction: null,
      gateway: { peersEnabled: false },
    })
    expect(botIdentityPrompt('/bot/chat')).toBe('')
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    expect(botIdentityPrompt('/other/chat')).toBe('')
    expect(botIdentityPrompt('/bot/chat')).toContain('# Bot identity\nYour name is Scout.')
    expect(botIdentityPrompt('/bot/chat')).toContain('Track updates.')
    expect(botIdentityPrompt('/bot/chat')).toContain('Node.js 22')
    expect(botIdentityPrompt('/bot/chat')).toContain('mise use node@20')
    expect(botIdentityPrompt('/bot/chat')).toContain('there is no sudo or Docker')
  })
})

describe('persistent input queue', () => {
  it('persists owner images as files and rejects mismatched magic bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-image-queue-'))
    try {
      const file = path.join(dir, 'fleet-instance', 'inputs.json')
      const queue = new InstanceInputQueue(file, attachmentsFor(file))
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
        'base64'
      )
      const input = {
        idempotencyKey: key(),
        source: 'owner' as const,
        text: '',
        attachments: [{ name: 'small.png', mediaType: 'image/png' as const, dataBase64: png.toString('base64') }],
      }
      const receipt = await queue.enqueue(input)
      expect(await readFile(path.join(attachmentsFor(file), receipt.inputId, '0.png'))).toEqual(png)
      const index = await readFile(file, 'utf8')
      expect(index).not.toContain(input.attachments[0].dataBase64)
      const reopened = new InstanceInputQueue(file, attachmentsFor(file))
      await reopened.load()
      expect(reopened.refs(reopened.list()[0])).toMatchObject([
        { id: `q-${receipt.inputId}-0`, mediaType: 'image/png' },
      ])
      expect((await reopened.readAttachments(reopened.list()[0]))[0].bytes).toEqual(png)
      expect((await reopened.readImage(`q-${receipt.inputId}-0`))?.bytes).toEqual(png)
      await expect(
        queue.enqueue({
          ...input,
          idempotencyKey: key(),
          attachments: [{ ...input.attachments[0], mediaType: 'image/jpeg' }],
        })
      ).rejects.toThrow('media type')
      expect(await reopened.delete(receipt.inputId)).toBe('deleted')
      await reopened.cleanup(receipt.inputId)
      expect(await reopened.readImage(`q-${receipt.inputId}-0`)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('keeps memory and disk unchanged after failed writes, then retries each mutation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const file = path.join(dir, 'queue.json')
      let failNext = true
      const queue = new InstanceInputQueue(file, attachmentsFor(file), async (target, contents) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        await writeFile(target, contents)
      })
      const input = { idempotencyKey: key(), source: 'owner' as const, text: 'hello' }
      await expect(queue.enqueue(input)).rejects.toThrow('disk full')
      expect(queue.list()).toHaveLength(0)
      const receipt = await queue.enqueue(input)
      const checkDisk = async () => {
        const reopened = new InstanceInputQueue(file, attachmentsFor(file))
        await reopened.load()
        expect(reopened.all()).toEqual(queue.all())
      }
      await checkDisk()
      failNext = true
      await expect(queue.markStarted(receipt.inputId)).rejects.toThrow('disk full')
      expect(queue.list()).toHaveLength(1)
      await checkDisk()
      await queue.markStarted(receipt.inputId)
      const removable = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text: 'remove' })
      failNext = true
      await expect(queue.delete(removable.inputId)).rejects.toThrow('disk full')
      expect(queue.list().map((item) => item.id)).toContain(removable.inputId)
      await checkDisk()
      expect(await queue.delete(removable.inputId)).toBe('deleted')
      const pending = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text: 'wait' })
      failNext = true
      const continuation = { idempotencyKey: key(), source: 'continuation' as const, text: 'resume' }
      await expect(queue.enqueue(continuation)).rejects.toThrow('disk full')
      expect(queue.list().map((item) => item.id)).toEqual([pending.inputId])
      await checkDisk()
      const next = await queue.enqueue(continuation)
      expect(queue.all()[0].id).toBe(next.inputId)
      expect(queue.list().map((item) => item.id)).toEqual([next.inputId, pending.inputId])
      await checkDisk()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('retains receipts, idempotency and continuation priority across restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const file = path.join(dir, 'inputs.json')
      const queue = new InstanceInputQueue(file, attachmentsFor(file))
      await queue.load()
      const firstKey = key()
      const first = await queue.enqueue({ idempotencyKey: firstKey, source: 'owner', text: 'hello' })
      const again = await queue.enqueue({ idempotencyKey: firstKey, source: 'owner', text: 'changed' })
      expect(again).toEqual(first)
      const second = await queue.enqueue({
        idempotencyKey: key(),
        source: 'routine',
        text: 'run',
        routine: { id: 'routine-1', title: 'Check' },
      })
      const continuation = await queue.enqueue({ idempotencyKey: key(), source: 'continuation', text: 'resume' })
      expect(queue.list().map((item) => item.id)).toEqual([continuation.inputId, first.inputId, second.inputId])
      const reopened = new InstanceInputQueue(file, attachmentsFor(file))
      await reopened.load()
      expect(reopened.list().map((item) => item.id)).toEqual([continuation.inputId, first.inputId, second.inputId])
      await reopened.markStarted(continuation.inputId)
      await reopened.mapNativeMessage(continuation.inputId, 'native-user')
      const mapped = new InstanceInputQueue(file, attachmentsFor(file))
      await mapped.load()
      expect(mapped.all().find((item) => item.id === continuation.inputId)?.nativeMessageId).toBe('native-user')
      expect(await reopened.delete(continuation.inputId)).toBe('started')
      expect(await reopened.delete(first.inputId)).toBe('deleted')
      expect(await reopened.delete('missing')).toBe('missing')
      expect(() =>
        promptForInput({ idempotencyKey: key(), source: 'peer', text: 'Hi', peer: { botId: 'peer', name: 'Peer' } })
      ).not.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('recovers an ambiguous turn admission without duplicating persisted native messages', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const file = path.join(dir, 'queue.json')
      const queue = new InstanceInputQueue(file, attachmentsFor(file))
      const receipt = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text: 'Hello' })
      await queue.markStarted(receipt.inputId)
      const beforeAdmission = new InstanceInputQueue(file, attachmentsFor(file))
      await beforeAdmission.load()
      await beforeAdmission.reconcile([])
      expect(beforeAdmission.list().map((item) => item.id)).toContain(receipt.inputId)
      await beforeAdmission.markStarted(receipt.inputId)
      const afterAdmission = new InstanceInputQueue(file, attachmentsFor(file))
      await afterAdmission.load()
      await afterAdmission.reconcile([{ id: 'native-user', at: Date.now(), text: 'Hello' }])
      expect(afterAdmission.list()).toHaveLength(0)
      expect(afterAdmission.all()[0].nativeMessageId).toBe('native-user')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('serializes overlapping atomic writes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const file = path.join(dir, 'queue.json')
      const queue = new InstanceInputQueue(file, attachmentsFor(file))
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          queue.enqueue({ idempotencyKey: key(), source: 'owner', text: String(index) })
        )
      )
      const reopened = new InstanceInputQueue(file, attachmentsFor(file))
      await reopened.load()
      expect(reopened.list()).toHaveLength(20)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('replays idempotency only within 24 hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const queue = new InstanceInputQueue(path.join(dir, 'queue.json'), path.join(dir, 'attachments'))
      const idempotencyKey = key()
      const first = await queue.enqueue({ idempotencyKey, source: 'owner', text: 'First' })
      vi.setSystemTime(new Date('2026-01-02T00:00:01.000Z'))
      const next = await queue.enqueue({ idempotencyKey, source: 'owner', text: 'Next' })
      expect(next.inputId).not.toBe(first.inputId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('uses exact source wrappers and requires source metadata', async () => {
    expect(promptForInput({ idempotencyKey: key(), source: 'owner', text: 'Hi' })).toBe('Hi')
    expect(
      promptForInput({ idempotencyKey: key(), source: 'routine', text: 'check', routine: { id: 'r', title: 'Daily' } })
    ).toBe('Scheduled routine "Daily". Do this now:\n\ncheck')
    expect(
      promptForInput({ idempotencyKey: key(), source: 'peer', text: 'hello', peer: { botId: 'p', name: 'Peer' } })
    ).toBe(
      'Message from bot "Peer" (id p), delivered by the Maestrly gateway:\n\nhello\n\nIf a reply is useful, send it with bot_peers_send.'
    )
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const queue = new InstanceInputQueue(path.join(dir, 'queue.json'), path.join(dir, 'attachments'))
      await expect(queue.enqueue({ idempotencyKey: key(), source: 'peer', text: 'hello' })).rejects.toThrow('metadata')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('transcript projection', () => {
  it('projects an image-only owner message without a native text part', () => {
    const message: ChatMessage = {
      id: 'm',
      conversationId: 'c',
      role: 'user',
      createdAt: Date.now(),
      parts: [
        {
          type: 'file',
          id: 'p',
          name: 'photo.png',
          mediaType: 'image/png',
          kind: 'image',
          artifactId: 'artifact',
          byteSize: 42,
        },
      ],
    }
    expect(projectChatMessages([message])).toMatchObject([
      { kind: 'user', text: '', images: [{ id: imageId('a', 'm', 'p'), name: 'photo.png' }] },
    ])
  })
  it('sends a tool output with images as its text only: the images travel as refs, never as JSON', () => {
    const tool = (id: string, output: unknown): MessagePart => ({
      type: 'tool',
      id,
      toolCallId: id,
      toolName: 'view_image',
      input: { path: '/tmp/crop.png' },
      state: { status: 'completed', output } as Extract<MessagePart, { type: 'tool' }>['state'],
    })
    const message: ChatMessage = {
      id: 'assistant',
      conversationId: 'c',
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        tool('viewed', {
          text: 'Viewed image: /tmp/crop.png',
          images: [{ id: 'tool-image:internal', mediaType: 'image/png', byteSize: 4, name: 'crop.png' }],
        }),
        tool('other', { delivered: true, text: 'kept as data' }),
      ],
    }
    const [viewed, other] = projectChatMessages([message])
    expect(viewed).toMatchObject({ kind: 'tool', output: 'Viewed image: /tmp/crop.png' })
    expect(JSON.stringify(viewed)).not.toContain('tool-image:internal')
    // Any other object is not a tool output envelope: it stays JSON.
    expect(other).toMatchObject({ kind: 'tool', output: JSON.stringify({ delivered: true, text: 'kept as data' }) })
  })
  it('keeps a long turn in the order it happened, across pages, and never shows a leftover tool as running', () => {
    const tool = (index: number, status: 'completed' | 'running'): MessagePart => ({
      type: 'tool',
      id: 'tool-' + index,
      toolCallId: 'tool-' + index,
      toolName: 'bash',
      input: { command: 'step ' + index },
      state: status === 'completed' ? { status, output: 'ok' } : { status },
    })
    const parts: MessagePart[] = [{ type: 'text', id: 'intro', text: 'Starting' }]
    for (let index = 1; index <= 11; index++) parts.push(tool(index, index === 3 ? 'running' : 'completed'))
    parts.push({ type: 'text', id: 'outro', text: 'Done' })
    const message = (id: string, finishReason?: string): ChatMessage => ({
      id,
      conversationId: 'c',
      role: 'assistant',
      createdAt: Date.parse('2026-09-24T21:29:45.794Z'),
      parts,
      ...(finishReason ? { finishReason } : {}),
    })
    const items = projectChatMessages([message('turn', 'stop')])
    const order = ['Starting', ...Array.from({ length: 11 }, (_, index) => 'step ' + (index + 1)), 'Done']
    const label = (item: FleetTranscriptItem) =>
      item.kind === 'tool' ? item.target : item.kind === 'assistant' ? item.text : item.kind
    const pages: FleetTranscriptItem[][] = []
    let before: string | null = null
    do {
      const page = transcriptPage(items, before, 5)
      pages.unshift(page.items)
      before = page.before
    } while (before)
    expect(pages.flat().map(label)).toEqual(order)
    // Its turn is over: nothing will ever update the third command (Codex kept a process nobody reported on).
    expect(items.find((item) => item.kind === 'tool' && item.target === 'step 3')).toMatchObject({
      state: 'interrupted',
    })
    // While the turn streams, it is still running.
    expect(
      projectChatMessages([message('live')]).find((item) => item.kind === 'tool' && item.target === 'step 3')
    ).toMatchObject({ state: 'running' })
  })
  it('attaches generated image refs to the producing tool item', () => {
    const message: ChatMessage = {
      id: 'assistant',
      conversationId: 'c',
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        {
          type: 'tool',
          id: 'tool',
          toolCallId: 'tool',
          toolName: 'generate_image',
          input: {},
          state: { status: 'completed', output: 'Image saved' },
        },
        {
          type: 'generated-image',
          id: 'generated',
          artifactId: 'artifact',
          name: 'generated.png',
          mediaType: 'image/png',
          byteSize: 100,
        },
      ],
    }
    expect(projectChatMessages([message])).toMatchObject([
      { kind: 'tool', images: [{ id: imageId('g', 'assistant', 'generated') }] },
    ])
  })
  it('keeps continuation source before and after native message id mapping', () => {
    const createdAt = Date.UTC(2026, 0, 1)
    const input = { idempotencyKey: key(), source: 'continuation' as const, text: 'The owner handed the screen back.' }
    const queued = {
      id: key(),
      itemId: 'input:continue',
      at: new Date(createdAt).toISOString(),
      input,
      attachments: [],
      started: true,
    }
    const messages = [
      {
        id: 'earlier',
        conversationId: 'c',
        role: 'user',
        createdAt: createdAt - 10_000,
        parts: [{ type: 'text', id: 't1', text: 'Earlier' }],
      },
      {
        id: 'native-continue',
        conversationId: 'c',
        role: 'user',
        createdAt: createdAt + 100,
        parts: [{ type: 'text', id: 't2', text: input.text }],
      },
    ] as ChatMessage[]
    expect(projectChatMessages(messages, [queued])[1]).toMatchObject({
      id: 'input:continue',
      kind: 'user',
      source: 'continuation',
    })
    expect(projectChatMessages(messages, [{ ...queued, nativeMessageId: 'native-continue' }])[1]).toMatchObject({
      id: 'input:continue',
      kind: 'user',
      source: 'continuation',
    })
    expect(projectChatMessages(messages, [queued])[0]).toMatchObject({ source: 'owner', text: 'Earlier' })
  })
  it('derives permission tools from call input and native command resources', () => {
    const messages = [
      {
        id: 'assistant',
        conversationId: 'c',
        role: 'assistant',
        createdAt: Date.now(),
        parts: [
          {
            type: 'tool',
            id: 'call',
            toolCallId: 'call',
            toolName: 'computer_click',
            input: { x: 10, y: 20 },
            state: { status: 'running' },
          },
        ],
      },
    ] as ChatMessage[]
    expect(
      permissionTool(
        { action: 'mcp', toolName: 'computer_click', toolCallId: 'call', resources: ['computer_click'] },
        messages
      )
    ).toEqual({ name: 'computer_click', target: '(10, 20)' })
    expect(permissionTool({ action: 'bash', toolName: 'bash', resources: ['ls -la'] }, [])).toEqual({
      name: 'bash',
      target: 'ls -la',
    })
    expect(permissionTool({ action: 'mcp', resources: ['computer_click'] }, [])).toBeNull()
  })
  it('maps native parts, keeps user metadata, omits reasoning and pages by stable ids', () => {
    const createdAt = Date.UTC(2026, 0, 1)
    const messages = [
      {
        id: 'user-message',
        conversationId: 'c',
        role: 'user',
        createdAt,
        parts: [{ type: 'text', id: 't', text: 'Scheduled routine "Daily". Do this now:\n\nOriginal' }],
      },
      {
        id: 'assistant-message',
        conversationId: 'c',
        role: 'assistant',
        createdAt: createdAt + 1,
        parts: [
          { type: 'text', id: 'text', text: 'Answer' },
          { type: 'reasoning', id: 'think', text: 'secret' },
          {
            type: 'tool',
            id: 'call',
            toolCallId: 'call',
            toolName: 'browser_navigate',
            input: { url: 'https://example.com/path' },
            state: { status: 'completed', output: 'done' },
          },
          {
            type: 'tool',
            id: 'question',
            toolCallId: 'question',
            toolName: 'ask_question',
            input: { questions: [{ question: 'Proceed?', header: 'Choice', options: [{ label: 'Yes' }] }] },
            state: { status: 'running' },
          },
          {
            type: 'tool',
            id: 'bad',
            toolCallId: 'bad',
            toolName: 'computer_click',
            input: { x: 10, y: 20 },
            state: { status: 'error', error: 'Failed' },
          },
        ],
      },
    ] as ChatMessage[]
    const inputs = [
      {
        id: key(),
        itemId: 'input:stable',
        at: new Date(createdAt).toISOString(),
        started: true,
        attachments: [],
        input: {
          idempotencyKey: key(),
          source: 'routine' as const,
          text: 'Original',
          routine: { id: 'r', title: 'Daily' },
        },
      },
    ]
    const items = projectChatMessages(messages, inputs)
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool', 'question', 'tool'])
    expect(items[0]).toMatchObject({ id: 'input:stable', kind: 'user', text: 'Original', source: 'routine' })
    expect(items[2]).toMatchObject({ id: 'assistant-message:2', target: 'example.com/path', state: 'done' })
    expect(items[4]).toMatchObject({ target: '(10, 20)', state: 'error' })
    expect(toolTarget({ command: 'x'.repeat(100) })).toHaveLength(80)
    const page = transcriptPage(items, null, 2)
    expect(page.items).toHaveLength(2)
    expect(transcriptPage(items, page.before, 2).items.map((item) => item.id)).toEqual(
      items.slice(1, 3).map((item) => item.id)
    )
  })
})

describe('transcript extras persistence', () => {
  it('keeps concurrent interaction writes through restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const file = path.join(dir, 'transcript.json')
      const extras = new InstanceTranscriptExtras(file, () => {})
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          extras.upsert({
            kind: 'system',
            id: 'system:' + index,
            at: new Date().toISOString(),
            code: 'created',
            text: null,
            durationMs: null,
          })
        )
      )
      const reopened = new InstanceTranscriptExtras(file, () => {})
      await reopened.load()
      expect(reopened.list()).toHaveLength(20)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('additional tool states', () => {
  it('projects pending, running, denied and awaiting permission without reasoning', () => {
    const parts = ['pending', 'running', 'denied', 'awaiting-permission'].map((status, index) => ({
      type: 'tool',
      id: String(index),
      toolCallId: String(index),
      toolName: 'computer_click',
      input: { x: index, y: index },
      state:
        status === 'denied'
          ? { status, reason: 'No' }
          : status === 'awaiting-permission'
            ? { status, title: 'Confirm' }
            : { status },
    }))
    const message = {
      id: 'assistant',
      conversationId: 'c',
      role: 'assistant',
      createdAt: Date.now(),
      parts: [...parts, { type: 'reasoning', id: 'r', text: 'hidden' }],
    } as ChatMessage
    expect(projectChatMessages([message]).map((item) => (item.kind === 'tool' ? item.state : item.kind))).toEqual([
      'running',
      'running',
      'error',
      'running',
    ])
    const aborted = {
      ...message,
      finishReason: 'aborted',
      parts: [
        {
          type: 'tool',
          id: 'stopped',
          toolCallId: 'stopped',
          toolName: 'computer_click',
          input: {},
          state: { status: 'error', error: 'Aborted' },
        },
      ],
    } as ChatMessage
    expect(projectChatMessages([aborted])[0]).toMatchObject({ kind: 'tool', state: 'interrupted' })
  })
})

describe('dispatcher conditions and release prompt', () => {
  it('requires readiness, account, idle turn and no hold', () => {
    expect(canDispatch(true, true, false, 'none')).toBe(true)
    expect(canDispatch(false, true, false, 'none')).toBe(false)
    expect(canDispatch(true, false, false, 'none')).toBe(false)
    expect(canDispatch(true, true, true, 'none')).toBe(false)
    expect(canDispatch(true, true, false, 'held')).toBe(false)
    expect(canDispatch(true, true, false, 'holding')).toBe(false)
    expect(canDispatch(true, true, false, 'none', false)).toBe(false)
    expect(canDispatch(true, true, false, 'none', true)).toBe(true)
  })
  it('renders exact continuation text', () => {
    expect(continuationText('takeover', 75_000, 'Fixed login')).toBe(
      'The owner used your screen for 1:15 and handed it back. Their note: "Fixed login". The screen may have changed: take a fresh screenshot before acting, then continue the task.'
    )
    expect(continuationText('paused', null, null)).toBe('The owner resumed you. Continue the task where you stopped.')
  })
})

describe('hold gate', () => {
  it('defers continuation and resume effects while paused, and retries release with one key', async () => {
    const manager = new InstanceHoldManager()
    await manager.hold('paused', true, async () => {})
    await manager.hold('takeover', false, async () => {})
    const input = vi.fn(async (_value: { idempotencyKey: string }) => ({
      inputId: 'input',
      itemId: 'item',
      queued: true,
    }))
    const system = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const resolveAll = vi.fn(async () => {})
    const runtime = Object.create(BotRuntime.prototype) as BotRuntime
    Object.assign(runtime, {
      holdManager: manager,
      help: { pending: () => [], resolveAll },
      input,
      system,
      changed: vi.fn(),
      tick: vi.fn(),
    })
    const request = { note: null, durationMs: null, continue: true }
    expect(await runtime.release(request)).toMatchObject({ state: 'held', reason: 'paused', interruptedTurn: true })
    expect(input).not.toHaveBeenCalled()
    expect(resolveAll).not.toHaveBeenCalled()
    await expect(runtime.release(request)).rejects.toThrow('disk full')
    expect(manager.state.state).toBe('held')
    expect(await runtime.release(request)).toMatchObject({ state: 'none' })
    expect(input).toHaveBeenCalledTimes(2)
    expect(input.mock.calls[0][0].idempotencyKey).toBe(input.mock.calls[1][0].idempotencyKey)
  })
  it('records a takeover note as a takeover transcript item and a pause note as resumed', () => {
    expect(releaseSystemCode('takeover')).toBe('takeover')
    expect(releaseSystemCode('paused')).toBe('resumed')
  })
  it('is inert outside bot mode and for other conversations, then refuses primary tools while held', async () => {
    const manager = new InstanceHoldManager()
    const unregister = registerInstanceHoldGate(manager, 'primary')
    try {
      expect(await gateInstanceAppTool('primary', async () => 'normal')).toBe('normal')
      vi.stubEnv('MAESTRLY_BOT_MODE', '1')
      expect(await gateInstanceAppTool('other', async () => 'other')).toBe('other')
      await manager.hold('takeover', false, async () => {})
      await expect(gateInstanceAppTool('primary', async () => 'no')).rejects.toThrow('owner has taken over')
      expect(await gateInstanceAppTool('other', async () => 'yes')).toBe('yes')
      manager.release()
      expect(await gateInstanceAppTool('primary', async () => 'yes')).toBe('yes')
    } finally {
      unregister()
    }
  })
  it('waits for in-flight calls, then cancels a turn and records interruption', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const manager = new InstanceHoldManager()
    let finish!: () => void
    const call = manager.gate(
      'primary',
      'primary',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    expect(manager.activeCalls).toBe(1)
    const cancel = vi.fn(async () => {})
    const holding = manager.hold('paused', true, cancel)
    const concurrent = manager.hold('paused', true, cancel)
    expect(manager.state.state).toBe('holding')
    await expect(manager.gate('primary', 'primary', async () => {})).rejects.toThrow('paused')
    finish()
    await call
    expect(await holding).toMatchObject({ state: 'held', interruptedTurn: true, reason: 'paused' })
    expect(await concurrent).toMatchObject({ state: 'held', interruptedTurn: true, reason: 'paused' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('keeps a pause after a takeover releases', async () => {
    const manager = new InstanceHoldManager()
    await manager.hold('paused', true, async () => {})
    await manager.hold('takeover', false, async () => {})
    expect(manager.releaseKeepsPaused).toBe(true)
    expect(manager.release()).toMatchObject({ state: 'held', reason: 'paused', interruptedTurn: true })
    expect(manager.release()).toMatchObject({ state: 'none', reason: null })
    await manager.hold('takeover', false, async () => {})
    await manager.hold('paused', false, async () => {})
    expect(manager.release()).toMatchObject({ state: 'held', reason: 'paused' })
  })
  it('stops waiting after ten seconds', async () => {
    vi.useFakeTimers()
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const manager = new InstanceHoldManager()
    let finish!: () => void
    const call = manager.gate(
      'primary',
      'primary',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const cancel = vi.fn(async () => {})
    const holding = manager.hold('takeover', true, cancel)
    const rejected = expect(holding).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(manager.state).toMatchObject({ state: 'none', reason: null })
    expect(cancel).toHaveBeenCalledOnce()
    finish()
    await call
  })
  it('retains pause after a takeover and rejects a release while holding', async () => {
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const manager = new InstanceHoldManager()
    await manager.hold('takeover', false, async () => {})
    await manager.hold('paused', false, async () => {})
    expect(manager.release()).toMatchObject({ state: 'held', reason: 'paused' })
    expect(manager.release()).toMatchObject({ state: 'none', reason: null })
    let finish!: () => void
    const call = manager.gate(
      'primary',
      'primary',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const holding = manager.hold('takeover', false, async () => {})
    expect(manager.release()).toMatchObject({ state: 'holding', reason: 'takeover' })
    finish()
    await call
    await holding
  })
})

describe('bot browser bounds', () => {
  it('fills the bot work area while keeping normal saved browser bounds', () => {
    const workArea = { x: 0, y: 0, width: 1280, height: 800 }
    const saved = { x: 40, y: 50, width: 940, height: 720 }
    expect(initialFloatingBounds('browser', true, workArea, saved)).toEqual(workArea)
    expect(initialFloatingBounds('browser', false, workArea, saved)).toBe(saved)
    expect(initialFloatingBounds('terminal', true, workArea, saved)).toBe(saved)
  })
})

describe('routine memory prompts', () => {
  const base = {
    idempotencyKey: key(),
    source: 'routine' as const,
    text: 'Check the stores',
    routine: { id: 'r1', title: 'Daily check' },
  }
  it('preserves the legacy prompt byte for byte without a run id', () => {
    expect(promptForInput(base)).toBe('Scheduled routine "Daily check". Do this now:\n\nCheck the stores')
  })
  it('renders previous reports and persists them across queue reloads', async () => {
    const input = {
      ...base,
      routine: {
        ...base.routine,
        runId: 'run-3',
        previousRuns: [
          {
            at: '2026-09-24T10:00:00.000Z',
            status: 'completed' as const,
            summary: 'Checked three stores',
            pending: 'One unavailable',
            notes: 'Retry that store first',
          },
          {
            at: '2026-09-23T10:00:00.000Z',
            status: 'failed' as const,
            summary: 'Checked two stores',
            pending: null,
            notes: null,
          },
        ],
      },
    }
    const prompt = promptForInput(input)
    expect(prompt).toContain('Previous runs of this routine, newest first:')
    expect(prompt).toContain('Checked three stores')
    expect(prompt).toContain('Checked two stores')
    expect(prompt).toContain('Pending: One unavailable')
    expect(prompt).toContain('Notes for this run: Retry that store first')
    expect(prompt).toMatch(/When you finish, call routine_report .*next run\.$/)
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-routine-memory-'))
    try {
      const file = path.join(dir, 'queue.json')
      const queue = new InstanceInputQueue(file, attachmentsFor(file))
      await queue.enqueue(input)
      const reopened = new InstanceInputQueue(file, attachmentsFor(file))
      await reopened.load()
      expect(reopened.list()[0].input.routine).toEqual(input.routine)
      expect(promptForInput(reopened.list()[0].input)).toBe(prompt)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('identifies the first recorded run', () => {
    expect(promptForInput({ ...base, routine: { ...base.routine, runId: 'run-1' } })).toContain(
      'This is the first recorded run of this routine.'
    )
  })
})

it('projects at most ten local recall sources on native user messages', () => {
  const sources = [
    { kind: 'shared' as const, id: 'shared', title: 'Shared' },
    ...Array.from({ length: 11 }, (_, i) => ({ kind: 'local' as const, id: `m${i}`, title: `Memory ${i}` })),
  ]
  const message: ChatMessage = {
    id: 'user',
    conversationId: 'conversation',
    role: 'user',
    createdAt: Date.now(),
    parts: [{ type: 'text', id: 'text', text: 'Hello' }],
    memoryContext: { revision: 'test', sources },
  }
  expect(projectChatMessages([message])).toMatchObject([
    { kind: 'user', memories: sources.slice(1, 11).map(({ id, title }) => ({ id, title })) },
  ])
})
