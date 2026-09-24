import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ChatMessage } from '../../src/shared/chat'
import { parseBotInstanceConfig } from '../../src/main/fleet/instance/config'
import { InstanceInputQueue, promptForInput } from '../../src/main/fleet/instance/queue'
import { InstanceHoldManager, gateInstanceAppTool, registerInstanceHoldGate } from '../../src/main/fleet/instance/gate'
import {
  InstanceTranscriptExtras,
  projectChatMessages,
  transcriptPage,
  toolTarget,
} from '../../src/main/fleet/instance/transcript'
import { canDispatch, continuationText, releaseSystemCode } from '../../src/main/fleet/instance/runtime'
import { botIdentityPrompt, setBotIdentity } from '../../src/main/fleet/instance/identity'

const key = () => randomUUID()
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
      gateway: { peersEnabled: false },
    })
    expect(botIdentityPrompt('/bot/chat')).toBe('')
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    expect(botIdentityPrompt('/other/chat')).toBe('')
    expect(botIdentityPrompt('/bot/chat')).toContain('# Bot identity\nYour name is Scout.')
    expect(botIdentityPrompt('/bot/chat')).toContain('Track updates.')
  })
})

describe('persistent input queue', () => {
  it('retains receipts, idempotency and continuation priority across restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-instance-'))
    try {
      const file = path.join(dir, 'inputs.json')
      const queue = new InstanceInputQueue(file)
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
      const reopened = new InstanceInputQueue(file)
      await reopened.load()
      expect(reopened.list().map((item) => item.id)).toEqual([continuation.inputId, first.inputId, second.inputId])
      await reopened.markStarted(continuation.inputId)
      await reopened.mapNativeMessage(continuation.inputId, 'native-user')
      const mapped = new InstanceInputQueue(file)
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
      const queue = new InstanceInputQueue(file)
      const receipt = await queue.enqueue({ idempotencyKey: key(), source: 'owner', text: 'Hello' })
      await queue.markStarted(receipt.inputId)
      const beforeAdmission = new InstanceInputQueue(file)
      await beforeAdmission.load()
      await beforeAdmission.reconcile([])
      expect(beforeAdmission.list().map((item) => item.id)).toContain(receipt.inputId)
      await beforeAdmission.markStarted(receipt.inputId)
      const afterAdmission = new InstanceInputQueue(file)
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
      const queue = new InstanceInputQueue(file)
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          queue.enqueue({ idempotencyKey: key(), source: 'owner', text: String(index) })
        )
      )
      const reopened = new InstanceInputQueue(file)
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
      const queue = new InstanceInputQueue(path.join(dir, 'queue.json'))
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
      const queue = new InstanceInputQueue(path.join(dir, 'queue.json'))
      await expect(queue.enqueue({ idempotencyKey: key(), source: 'peer', text: 'hello' })).rejects.toThrow('metadata')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('transcript projection', () => {
  it('maps native parts, keeps user metadata, omits reasoning and pages by stable ids', () => {
    const createdAt = Date.UTC(2026, 0, 1)
    const messages = [
      {
        id: 'user-message',
        conversationId: 'c',
        role: 'user',
        createdAt,
        parts: [{ type: 'text', id: 't', text: 'wrapped prompt' }],
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
  })
  it('renders exact continuation text', () => {
    expect(continuationText('takeover', 75_000, 'Fixed login')).toBe(
      'The owner used your screen for 1:15 and handed it back. Their note: "Fixed login". The screen may have changed: take a fresh screenshot before acting, then continue the task.'
    )
    expect(continuationText('paused', null, null)).toBe('The owner resumed you. Continue the task where you stopped.')
  })
})

describe('hold gate', () => {
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
    await manager.hold('paused', false, async () => {})
    await manager.hold('takeover', false, async () => {})
    expect(manager.release()).toMatchObject({ state: 'held', reason: 'paused' })
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
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await holding).state).toBe('held')
    expect(cancel).toHaveBeenCalledOnce()
    finish()
    await call
  })
})
