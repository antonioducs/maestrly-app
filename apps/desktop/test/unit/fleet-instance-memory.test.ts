import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetOwnerMemory } from '@maestrly/bot-fleet-protocol'
import { OwnerMemoryClient } from '../../src/main/fleet/instance/owner-memory'
import { BotRuntime } from '../../src/main/fleet/instance/runtime'
import { LiveTranscript } from '../../src/main/fleet/instance/live-transcript'
import { InstanceHoldManager } from '../../src/main/fleet/instance/gate'
import { InstanceHttpError } from '../../src/main/fleet/instance/server'
import { createLocalMemory, getLocalMemory } from '../../src/main/memory/local-memory-service'
import * as chatService from '../../src/main/chat/service'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { InstanceEvents } from '../../src/main/fleet/instance/server'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { loadMemoryCoreExtras } from '../../src/main/memory/core'
import { getOwnerMemoryWriter } from '../../src/main/memory/extraction/owner-writer'
import { botMemorySpaceId, memorySpaceForConversation } from '../../src/main/memory/spaces'
import { freshDb, closeDb } from '../helpers/db'

const at = '2026-09-20T10:00:00.000Z'
const entry = {
  id: randomUUID(),
  content: 'Prefer short answers.',
  status: 'active' as const,
  author: { kind: 'bot' as const, botId: 'scout', name: 'Scout' },
  origin: 'owner' as const,
  replacesId: null,
  replacedById: null,
  environmentId: null,
  createdAt: at,
  updatedAt: at,
}
const memory: FleetOwnerMemory = {
  revision: 1,
  activeChars: 42,
  entries: [entry, { ...entry, id: randomUUID(), author: { kind: 'owner' } }],
}
const gateway = { url: 'http://gateway.test', token: 'synthetic-token' }
const BOT_SPACE = botMemorySpaceId('scout')
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('owner memory client', () => {
  it('formats author metadata and falls back to cached sections after a failure', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(memory)).mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetch)
    const client = new OwnerMemoryClient(gateway)
    const sections = await client.coreSections(new AbortController().signal)
    expect(sections).toMatchObject([
      { key: 'owner', entries: [{ meta: 'Scout · 2026-09-20' }, { meta: 'you · 2026-09-20' }] },
    ])
    expect(await client.coreSections(new AbortController().signal)).toEqual(sections)
    expect(timeout).toHaveBeenLastCalledWith(1_000)
  })
  it('returns null without a cached copy and no section without a gateway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await new OwnerMemoryClient(gateway).coreSections(new AbortController().signal)).toBeNull()
    expect(await new OwnerMemoryClient(null).coreSections(new AbortController().signal)).toEqual([])
  })
  it('uses the configured timeout to return the cached copy', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(memory))
      .mockImplementationOnce(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
          })
      )
    vi.stubGlobal('fetch', fetch)
    const client = new OwnerMemoryClient(gateway, 20)
    await client.get()
    expect(await client.get()).toEqual(memory)
  })
  it('posts idempotent saves, invalidates the cache and exposes the automatic writer', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(memory))
      .mockResolvedValueOnce(Response.json(entry))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json(memory))
      .mockResolvedValueOnce(Response.json(entry))
    vi.stubGlobal('fetch', fetch)
    const client = new OwnerMemoryClient(gateway)
    await client.get()
    expect(await client.save({ content: entry.content, origin: 'owner' })).toEqual(entry)
    expect(String(fetch.mock.calls[1][0])).toBe('http://gateway.test/internal/v1/owner-memory')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      content: entry.content,
      origin: 'owner',
      idempotencyKey: expect.any(String),
    })
    expect(await client.get()).toBeNull()
    expect(await client.writer().list()).toEqual(memory.entries.map(({ id, content }) => ({ id, content })))
    await client.writer().save({ content: entry.content, origin: 'auto' })
    expect(JSON.parse(fetch.mock.calls[4][1].body).origin).toBe('auto')
  })
})

describe('instance durable memory control', () => {
  beforeEach(freshDb)
  afterEach(closeDb)
  const runtime = () => Object.assign(Object.create(BotRuntime.prototype) as BotRuntime, { botId: 'scout' })
  it('lists only bot memories and truncates transport content without changing storage', async () => {
    const local = createLocalMemory({
      workspaceId: BOT_SPACE,
      title: 'Portal',
      content: 'x'.repeat(4001),
      type: 'reference',
      source: 'auto',
    }).memory
    createLocalMemory({
      workspaceId: 'another-space',
      title: 'Other',
      content: 'Other fact',
      type: 'reference',
      source: 'user',
    })
    createLocalMemory({
      workspaceId: botMemorySpaceId('sibling'),
      title: 'Sibling',
      content: 'A sibling bot of the environment knows this',
      type: 'reference',
      source: 'auto',
    })
    expect(await runtime().memories('active')).toEqual({
      memories: [
        {
          id: local.id,
          title: 'Portal',
          content: 'x'.repeat(4000),
          truncated: true,
          type: 'reference',
          status: 'active',
          pinned: false,
          source: 'auto',
          useCount: 0,
          createdAt: new Date(local.createdAt).toISOString(),
          updatedAt: new Date(local.updatedAt).toISOString(),
        },
      ],
    })
    expect(getLocalMemory(BOT_SPACE, local.id)?.content).toHaveLength(4001)
  })
  it('pins, archives, restores and forgets a memory', async () => {
    const local = createLocalMemory({
      workspaceId: BOT_SPACE,
      title: 'Portal',
      content: 'Open the portal',
      type: 'procedure',
      source: 'agent',
    }).memory
    const bot = runtime()
    expect(await bot.patchMemory(local.id, { pinned: true })).toMatchObject({ pinned: true })
    expect(await bot.patchMemory(local.id, { status: 'archived' })).toMatchObject({ status: 'archived' })
    expect((await bot.memories('active')).memories).toEqual([])
    expect((await bot.memories('all')).memories).toHaveLength(1)
    expect(await bot.patchMemory(local.id, { status: 'active' })).toMatchObject({ status: 'active' })
    await bot.deleteMemory(local.id)
    expect(getLocalMemory(BOT_SPACE, local.id)).toBeUndefined()
  })
  it('rejects unknown and other-space ids with HTTP 404', async () => {
    const other = createLocalMemory({
      workspaceId: 'another-space',
      title: 'Other',
      content: 'Other fact',
      type: 'reference',
      source: 'user',
    }).memory
    const sibling = createLocalMemory({
      workspaceId: botMemorySpaceId('sibling'),
      title: 'Sibling',
      content: 'A sibling bot fact',
      type: 'reference',
      source: 'auto',
    }).memory
    for (const id of ['missing', other.id, sibling.id]) {
      await expect(runtime().patchMemory(id, { pinned: true })).rejects.toBeInstanceOf(InstanceHttpError)
      await expect(runtime().patchMemory(id, { pinned: true })).rejects.toMatchObject({ status: 404 })
      await expect(runtime().deleteMemory(id)).rejects.toMatchObject({ status: 404 })
    }
  })
  it('finds the active input even after it has left the pending queue', () => {
    const bot = runtime()
    Object.assign(bot, {
      turnInputId: 'input',
      queue: {
        list: () => [],
        all: () => [
          {
            id: 'input',
            started: true,
            input: { source: 'routine', routine: { id: 'r1', title: 'Check', runId: 'run-1' } },
          },
        ],
      },
    })
    expect(bot.currentInput()).toEqual({ source: 'routine', routine: { id: 'r1', title: 'Check', runId: 'run-1' } })
    Object.assign(bot, { turnInputId: null })
    expect(bot.currentInput()).toBeNull()
  })
})

describe('runtime turn memory integration', () => {
  beforeEach(freshDb)
  afterEach(closeDb)
  it('registers the bot space, owner core and writer and clears them on dispose', async () => {
    const conversation = makeConversation(makeWorkspace().id)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(memory)))
    const bot = Object.create(BotRuntime.prototype) as BotRuntime
    const idle = { idle: async () => {} }
    Object.assign(bot, {
      botId: 'scout',
      host: { gatewayUrl: gateway.url },
      gatewayToken: gateway.token,
      stored: { primaryConversationId: conversation.id },
      ownerMemory: new OwnerMemoryClient(gateway),
      holdManager: new InstanceHoldManager(),
      applyProfile: () => {},
      syncCompaction: async () => {},
      floatAttempted: true,
      floatTimers: new Set(),
      queue: idle,
      extras: idle,
      images: idle,
      usageTask: Promise.resolve(),
      turnSettled: Promise.resolve(),
    })
    try {
      await (bot as unknown as { ensureConversation(): Promise<void> }).ensureConversation()
      expect(memorySpaceForConversation(conversation.id)).toEqual({ id: BOT_SPACE, kind: 'bot', roots: [] })
      expect(await loadMemoryCoreExtras(conversation.id, new AbortController().signal)).toMatchObject([
        { key: 'owner' },
      ])
      expect(getOwnerMemoryWriter(conversation.id)).toBeDefined()
    } finally {
      await bot.dispose()
    }
    expect(memorySpaceForConversation(conversation.id)?.kind).not.toBe('bot')
    expect(await loadMemoryCoreExtras(conversation.id, new AbortController().signal)).toEqual([])
    expect(getOwnerMemoryWriter(conversation.id)).toBeUndefined()
  })
  it.each(['owner', 'routine', 'continuation', 'cancelled', 'error', 'throw'] as const)(
    'passes memory options and reports the current input and final text: %s',
    async (scenario) => {
      const conversation = makeConversation(makeWorkspace().id)
      const source = scenario === 'routine' || scenario === 'continuation' ? scenario : 'owner'
      const item = {
        id: 'input-1',
        itemId: 'input:input-1',
        at,
        started: false,
        input: {
          source,
          text: 'Check the portal',
          ...(source === 'routine' ? { routine: { id: 'r1', title: 'Daily check', runId: 'run-1' } } : {}),
        },
      }
      const events = new InstanceEvents()
      const queue = {
        list: () => (item.started ? [] : [item]),
        all: () => [item],
        transcriptInputs: () => ({ forMessage: () => undefined, unmapped: item.started ? [item] : [] }),
        byItemId: () => undefined,
        readAttachments: async () => [],
        markStarted: async () => {
          item.started = true
        },
        cleanup: async () => {},
        reconcile: async () => {},
      }
      const bot = Object.create(BotRuntime.prototype) as BotRuntime
      Object.assign(bot, {
        botId: 'scout',
        stored: { primaryConversationId: conversation.id },
        retryAt: 0,
        ready: true,
        turning: false,
        accountOptions: [{}],
        compactionProblem: null,
        manualCompacting: false,
        refreshAccounts: async () => {},
        applyProfile: () => {},
        changed: () => {},
        refreshUsage: async () => {},
        holdManager: { state: { state: 'none' } },
        events,
        images: { toolRefs: () => [] },
        live: new LiveTranscript({
          conversationId: () => conversation.id,
          queue: queue as never,
          extras: { list: () => [] } as never,
          images: { captureMessages: async () => {}, toolRefs: () => [] } as never,
          publish: () => {},
        }),
        system: async () => {},
        queue,
      })
      const start = vi.spyOn(chatService, 'startExecutorChatTurn').mockImplementation(async (input) => {
        expect(bot.currentInput()?.source).toBe(source)
        if (scenario === 'throw') throw new Error('Synthetic admission failure')
        upsertChatMessage({
          id: 'assistant',
          conversationId: conversation.id,
          role: 'assistant',
          createdAt: Date.now(),
          parts: [
            { type: 'reasoning', id: 'private', text: 'Not final text' },
            { type: 'text', id: 'first', text: 'Done' },
            { type: 'text', id: 'second', text: 'x'.repeat(4001) },
          ],
        })
        input.slot?.release()
        return {
          executionId: conversation.id,
          conversationId: conversation.id,
          assistantMessageId: () => 'assistant',
          cancel: () => {},
          done: Promise.resolve(
            scenario === 'error'
              ? { status: 'error', error: 'Synthetic turn failure', assistantMessageId: 'assistant' }
              : { status: scenario === 'cancelled' ? 'cancelled' : 'success', assistantMessageId: 'assistant' }
          ),
        }
      })
      await (bot as unknown as { tick(): Promise<void> }).tick()
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ skipMemory: source === 'continuation', memoryQuery: item.input.text })
      )
      expect(events.replay(0)).toEqual([
        expect.objectContaining({
          type: 'turn.finished',
          botId: 'scout',
          inputId: item.id,
          text: scenario === 'throw' ? null : 'Done\n' + 'x'.repeat(3995),
          outcome:
            scenario === 'throw' || scenario === 'error'
              ? 'failed'
              : scenario === 'cancelled'
                ? 'cancelled'
                : 'completed',
        }),
      ])
      expect(bot.currentInput()).toBeNull()
    }
  )
})
