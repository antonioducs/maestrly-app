import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  readyRuntimeAsset: vi.fn(),
  /** Cached Codex auth gates without refresh or process startup. */
  authenticated: true,
  generateImageForConversation: vi.fn(),
  anyCodexFailoverAccountConnected: vi.fn(() => h.authenticated),
}))
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  readyRuntimeAsset: h.readyRuntimeAsset,
}))
vi.mock('../../src/main/chat/codex-subscription/manager', () => ({
  getCodexSubscriptionManager: () => ({
    getStatusSnapshot: () => ({ authenticated: h.authenticated, state: 'ready', available: true, connected: true }),
  }),
}))
vi.mock('../../src/main/chat/subscription-failover', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/subscription-failover')>()
  return {
    ...original,
    anyCodexFailoverAccountConnected: h.anyCodexFailoverAccountConnected,
  }
})
// Only the high-level account/client/model entry point is mocked; the ephemeral
// thread engine and model resolver remain real and are exercised below.
vi.mock('../../src/main/chat/codex-subscription/image-generation', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/chat/codex-subscription/image-generation')>()
  return { ...original, generateImageForConversation: h.generateImageForConversation }
})

import type { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import type { CodexNotification } from '../../src/main/chat/codex-subscription/protocol'
import { app } from 'electron'
import {
  generateImageWithCodexRuntime,
  resolveImageGenModel,
} from '../../src/main/chat/codex-subscription/image-generation'
import { summarizeWithCodexRuntime } from '../../src/main/chat/portable-summarizer'
import {
  emitGeneratedImagePart,
  generateImageToolEnabled,
  imageGenEnabledFor,
  mergeGeneratedImageUsage,
} from '../../src/main/chat/image-gen'
import type { ChatStreamEvent } from '../../src/shared/chat'
import { generateImageTool } from '../../src/main/chat/tools/generate-image'
import type { GeneratedImageUsage, ToolContext } from '../../src/main/chat/tools/util'
import { readGeneratedImage, saveGeneratedImage } from '../../src/main/chat/generated-images'
import { patchConvUiPrefs, setAppFlag } from '../../src/main/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

/**
 * imagegen for non-Codex models: an EPHEMERAL app-server thread draws the image; the artifact goes to the
 * app-owned store while models receive text references. These tests protect
 * thread cleanup, exclusion of base64 from model responses and explicit failures.
 */

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
// The global Electron stub shares userData across forks. This spec deletes its artifacts in
// afterEach, so each suite needs a separate root to avoid deleting concurrent writes.
const artifactsUserData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-image-gen-'))
const appGetPathSpy = vi.spyOn(app, 'getPath').mockReturnValue(artifactsUserData)
const artifactsRoot = path.join(artifactsUserData, 'chat-generated-images')

type NotificationListener = (notification: CodexNotification) => void

class FakeImageClient {
  readonly startThreadCalls: unknown[] = []
  readonly startTurnCalls: unknown[] = []
  readonly deleteThreadCalls: unknown[] = []
  readonly interruptTurnCalls: unknown[] = []
  failure: Error | null = null
  /** Scripted notifications emitted immediately after startTurn. */
  notifications: CodexNotification[] = []
  /** When true, the turn never completes on its own (to exercise abort). */
  hang = false

  private readonly listeners = new Set<NotificationListener>()

  async startThread(params: unknown): Promise<{ thread: { id: string } }> {
    this.startThreadCalls.push(params)
    return { thread: { id: 'thread_img' } }
  }

  async startTurn(params: unknown): Promise<{ turn: { id: string } }> {
    this.startTurnCalls.push(params)
    if (!this.hang) {
      setImmediate(() => {
        for (const notification of this.notifications) this.emit(notification)
      })
    }
    return { turn: { id: 'turn_img' } }
  }

  emit(notification: CodexNotification): void {
    for (const listener of [...this.listeners]) listener(notification)
  }

  async interruptTurn(params: unknown): Promise<void> {
    this.interruptTurnCalls.push(params)
  }

  async deleteThread(params: unknown): Promise<Record<string, never>> {
    this.deleteThreadCalls.push(params)
    return {}
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  waitForExit(): Promise<never> {
    return new Promise<never>(() => {})
  }
}

const imageItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'item_img',
  type: 'imageGeneration',
  status: 'completed',
  revisedPrompt: 'A teal robot on white',
  result: PNG_1X1,
  ...overrides,
})

const notification = (method: string, params: Record<string, unknown>): CodexNotification =>
  ({ method, params: { threadId: 'thread_img', ...params } }) as unknown as CodexNotification

const asClient = (client: FakeImageClient): CodexAppServerClient => client as unknown as CodexAppServerClient
const setAppPackaged = (value: boolean): void => {
  Object.defineProperty(app, 'isPackaged', { configurable: true, value })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.readyRuntimeAsset.mockReset()
  setAppPackaged(false)
  h.authenticated = true
  freshDb()
})
afterEach(() => {
  closeDb()
  rmSync(artifactsRoot, { recursive: true, force: true })
})
afterAll(() => {
  appGetPathSpy.mockRestore()
  rmSync(artifactsUserData, { recursive: true, force: true })
})

describe('generateImageWithCodexRuntime ephemeral thread', () => {
  const run = (
    client: FakeImageClient,
    conversationId: string,
    signal = new AbortController().signal,
    modelId = 'gpt-5.6-mini'
  ) =>
    generateImageWithCodexRuntime({
      client: asClient(client),
      conversationId,
      cwd: os.tmpdir(),
      modelId,
      prompt: 'a teal robot',
      signal,
    })

  it('writes the artifact and returns only its handle while always deleting the ephemeral thread', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('turn/started', { turn: { id: 'turn_img' } }),
      notification('thread/tokenUsage/updated', {
        turnId: 'turn_img',
        tokenUsage: {
          total: {
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 7,
            reasoningOutputTokens: 0,
          },
          last: {
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 7,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      }),
      notification('item/completed', { item: imageItem() }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'completed' } }),
    ]

    const usage = vi.fn()
    const image = await generateImageWithCodexRuntime({
      client: asClient(client),
      conversationId: 'conv_img',
      cwd: os.tmpdir(),
      modelId: 'gpt-5.6-mini',
      prompt: 'a teal robot',
      signal: new AbortController().signal,
      onUsage: usage,
    })

    expect(image.artifactId).toMatch(/^[a-f0-9]{32}$/)
    expect(image.mediaType).toBe('image/png')
    expect(image.name).toBe('A-teal-robot-on-white.png')
    expect(image.revisedPrompt).toBe('A teal robot on white')
    expect(image.usage).toEqual({
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 100,
      output: 7,
      cachedInput: 20,
    })
    expect(usage).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledWith(image.usage)
    expect(readdirSync(path.join(artifactsRoot, 'conv_img'))).toEqual([`${image.artifactId}.png`])
    // Handles and metadata contain no base64; bytes live only in files.
    expect(JSON.stringify(image)).not.toContain(PNG_1X1.slice(0, 32))
    // Ephemeral threads never survive requests or create resumable bindings.
    expect(client.deleteThreadCalls).toEqual([{ threadId: 'thread_img' }])
    // The thread starts with imagegen enabled and everything else disabled.
    expect(client.startThreadCalls[0]).toMatchObject({
      ephemeral: true,
      environments: [],
      config: { 'features.image_generation': true, 'features.shell_tool': false, web_search: 'disabled' },
    })
  })

  it('accounts for consumed tokens after failed turns', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('thread/tokenUsage/updated', {
        tokenUsage: {
          total: {
            inputTokens: 40,
            cachedInputTokens: 0,
            outputTokens: 3,
            reasoningOutputTokens: 0,
          },
          last: {
            inputTokens: 40,
            cachedInputTokens: 0,
            outputTokens: 3,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'failed' } }),
    ]
    const usage = vi.fn()

    await expect(
      generateImageWithCodexRuntime({
        client: asClient(client),
        conversationId: 'conv_failed_usage',
        cwd: os.tmpdir(),
        modelId: 'gpt-5.6-mini',
        prompt: 'a teal robot',
        signal: new AbortController().signal,
        onUsage: usage,
      })
    ).rejects.toThrow(/Image generation failed/i)
    expect(usage).toHaveBeenCalledWith({
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 40,
      output: 3,
    })
  })

  it('uses effective candidate models in image threads', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('item/completed', { item: imageItem() }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'completed' } }),
    ]

    await run(client, 'conv_default_model', new AbortController().signal, 'gpt-5.6-default')

    expect(client.startThreadCalls[0]).toMatchObject({ model: 'gpt-5.6-default' })
    expect(client.startTurnCalls[0]).toMatchObject({
      model: 'gpt-5.6-default',
      collaborationMode: { settings: { model: 'gpt-5.6-default' } },
    })
  })

  it('fails explicitly without an artifact when no image item arrives', async () => {
    const client = new FakeImageClient()
    client.notifications = [notification('turn/completed', { turn: { id: 'turn_img', status: 'completed' } })]

    await expect(run(client, 'conv_empty')).rejects.toThrow(/did not produce an image/i)
    expect(existsSync(path.join(artifactsRoot, 'conv_empty'))).toBe(false)
    expect(client.deleteThreadCalls).toHaveLength(1)
  })

  it('fails explicitly for failed image items', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('item/completed', { item: imageItem({ status: 'failed' }) }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'completed' } }),
    ]

    await expect(run(client, 'conv_failed')).rejects.toThrow(/Image generation failed/i)
    expect(existsSync(path.join(artifactsRoot, 'conv_failed'))).toBe(false)
  })

  it('rejects invalid base64 without leaving partial files', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('item/completed', { item: imageItem({ result: 'not base64 !!!' }) }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'completed' } }),
    ]

    await expect(run(client, 'conv_bad')).rejects.toThrow(/base64/i)
    expect(existsSync(path.join(artifactsRoot, 'conv_bad'))).toBe(false)
  })

  it('interrupts and deletes threads on mid-turn abort', async () => {
    const client = new FakeImageClient()
    client.hang = true
    const controller = new AbortController()
    const usage = vi.fn()
    const promise = generateImageWithCodexRuntime({
      client: asClient(client),
      conversationId: 'conv_abort',
      cwd: os.tmpdir(),
      modelId: 'gpt-5.6-mini',
      prompt: 'a teal robot',
      signal: controller.signal,
      onUsage: usage,
    })
    // The turn has already started when the user presses Stop.
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))
    client.emit(
      notification('thread/tokenUsage/updated', {
        tokenUsage: {
          total: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 3 },
          last: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 3 },
        },
      })
    )
    controller.abort(new Error('stopped'))

    await expect(promise).rejects.toThrow()
    expect(usage).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledWith({
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 40,
      output: 3,
    })
    expect(client.interruptTurnCalls.length).toBeGreaterThan(0)
    expect(client.deleteThreadCalls).toHaveLength(1)
  })

  it('cleans late threads after cancelled startup', async () => {
    let resolveStart!: (value: { thread: { id: string } }) => void
    class SlowThreadClient extends FakeImageClient {
      override async startThread(params: unknown): Promise<{ thread: { id: string } }> {
        this.startThreadCalls.push(params)
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      }
    }
    const client = new SlowThreadClient()
    const controller = new AbortController()
    const promise = run(client, 'conv_abort_start_thread', controller.signal)
    await vi.waitFor(() => expect(client.startThreadCalls).toHaveLength(1))

    controller.abort(new Error('stopped while starting thread'))
    await expect(promise).rejects.toThrow(/stopped while starting thread/i)
    expect(client.startTurnCalls).toHaveLength(0)

    resolveStart({ thread: { id: 'thread_late' } })
    await vi.waitFor(() => expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_late' }))
  })

  it('interrupts late turns after cancelled startup', async () => {
    let resolveTurn!: (value: { turn: { id: string } }) => void
    class SlowTurnClient extends FakeImageClient {
      override async startTurn(params: unknown): Promise<{ turn: { id: string } }> {
        this.startTurnCalls.push(params)
        return new Promise((resolve) => {
          resolveTurn = resolve
        })
      }
    }
    const client = new SlowTurnClient()
    const controller = new AbortController()
    const promise = run(client, 'conv_abort_start_turn', controller.signal)
    await vi.waitFor(() => expect(client.startTurnCalls).toHaveLength(1))

    controller.abort(new Error('stopped while starting turn'))
    await expect(promise).rejects.toThrow(/stopped while starting turn/i)
    expect(client.deleteThreadCalls).toContainEqual({ threadId: 'thread_img' })

    resolveTurn({ turn: { id: 'turn_late' } })
    await vi.waitFor(() =>
      expect(client.interruptTurnCalls).toContainEqual({ threadId: 'thread_img', turnId: 'turn_late' })
    )
  })
})

describe('resolveImageGenModel', () => {
  const manager = (models: Array<{ id: string; isDefault?: boolean }>) =>
    ({
      listModels: async () => models.map((m) => ({ ...m, model: m.id, isDefault: m.isDefault === true })),
    }) as unknown as Parameters<typeof resolveImageGenModel>[0]

  it('prefers the smallest mini model in the catalog', async () => {
    await expect(
      resolveImageGenModel(manager([{ id: 'gpt-5.6-sol', isDefault: true }, { id: 'gpt-5.6-mini' }]))
    ).resolves.toBe('gpt-5.6-mini')
  })

  it('uses the catalog default when no mini exists', async () => {
    await expect(
      resolveImageGenModel(manager([{ id: 'gpt-5.6-a' }, { id: 'gpt-5.6-b', isDefault: true }]))
    ).resolves.toBe('gpt-5.6-b')
  })

  it('uses the candidate catalog without requiring a fixed mini model', async () => {
    const availableModels = await manager([{ id: 'gpt-5.6-default', isDefault: true }]).listModels()
    const managerWithoutCatalogRead = {
      listModels: async () => {
        throw new Error('catalog should not be read twice')
      },
    } as unknown as Parameters<typeof resolveImageGenModel>[0]

    await expect(resolveImageGenModel(managerWithoutCatalogRead, availableModels)).resolves.toBe('gpt-5.6-default')
  })

  it('uses a constant fallback when model discovery is unavailable', async () => {
    const failing = {
      listModels: async () => {
        throw new Error('offline')
      },
    } as unknown as Parameters<typeof resolveImageGenModel>[0]
    await expect(resolveImageGenModel(failing)).resolves.toBe('gpt-5.6-mini')
  })
})

describe('generateImageForConversation account resolution', () => {
  it('returns a connection hint when no Codex account is authenticated', async () => {
    h.authenticated = false
    const { generateImageForConversation } = await vi.importActual<
      typeof import('../../src/main/chat/codex-subscription/image-generation')
    >('../../src/main/chat/codex-subscription/image-generation')

    await expect(
      generateImageForConversation({
        conversationId: 'conv_disconnected_imagegen',
        cwd: os.tmpdir(),
        prompt: 'a teal robot',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/Connect your ChatGPT \(Codex\).*generate images/i)
  })
})

describe('auxiliary Codex thread isolation', () => {
  it('explicitly disables imagegen for portable compaction', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('item/completed', {
        item: { id: 'summary', type: 'agentMessage', text: 'Portable summary.' },
      }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'completed' } }),
    ]

    await expect(
      summarizeWithCodexRuntime({
        client: asClient(client),
        cwd: os.tmpdir(),
        modelId: 'gpt-5.6-mini',
        system: 'Summarize only.',
        prompt: 'Summarize this transcript.',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ text: 'Portable summary.' })

    expect(client.startThreadCalls[0]).toMatchObject({
      dynamicTools: [],
      environments: [],
      config: { 'features.image_generation': false },
    })
  })

  it('preserves partial usage when the ephemeral thread hits quota', async () => {
    const client = new FakeImageClient()
    client.notifications = [
      notification('thread/tokenUsage/updated', {
        tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 } },
      }),
      notification('turn/completed', { turn: { id: 'turn_img', status: 'failed' } }),
    ]

    const error = await summarizeWithCodexRuntime({
      client: asClient(client),
      cwd: os.tmpdir(),
      modelId: 'gpt-5.6-mini',
      system: 'Summarize only.',
      prompt: 'Summarize this transcript.',
      signal: new AbortController().signal,
    }).catch((value: unknown) => value)

    expect(error).toMatchObject({
      message: 'Codex portable compaction failed',
      partialUsage: { input: 60, output: 7, cacheRead: 40, cacheCreate: 0, totalInput: 100 },
    })
  })
})

describe('tool generate_image', () => {
  const worktrees = new Set<string>()
  const makeWorktree = (): string => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-image-tool-'))
    worktrees.add(cwd)
    return cwd
  }

  afterEach(() => {
    for (const cwd of worktrees) rmSync(cwd, { recursive: true, force: true })
    worktrees.clear()
  })

  const ctx = (overrides: Partial<ToolContext> = {}): ToolContext =>
    ({
      conversationId: 'conv_tool',
      projectId: 'ws',
      messageId: 'm1',
      toolCallId: 'call_1',
      cwd: os.tmpdir(),
      signal: new AbortController().signal,
      ask: async () => {},
      askQuestion: async () => [],
      ...overrides,
    }) as ToolContext

  it('emits the handle part and returns only a textual reference to the model', async () => {
    const emitted: unknown[] = []
    const generated = {
      artifactId: 'a'.repeat(32),
      name: 'a-teal-robot.png',
      mediaType: 'image/png',
      byteSize: 68,
      revisedPrompt: 'A teal robot on white',
    }
    h.generateImageForConversation.mockResolvedValueOnce(generated)

    const args = { prompt: 'a teal robot' }
    const result = await generateImageTool.execute(args, ctx({ emitGeneratedImage: (i) => emitted.push(i) }))
    const text = generateImageTool.toModelText(args, result)

    expect(emitted).toEqual([generated])
    expect(text).toContain('a-teal-robot.png')
    expect(text).toContain('A teal robot on white')
    expect(text).toContain('chat-only preview')
    // The 1 MB incident invariant: the model response NEVER contains image bytes.
    expect(text).not.toContain(PNG_1X1.slice(0, 16))
  })

  it('counts generation once when runtime callback and image.usage both arrive', async () => {
    const usage: GeneratedImageUsage = {
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 100,
      output: 7,
      cachedInput: 20,
    }
    const generated = {
      artifactId: 'u'.repeat(32),
      name: 'usage.png',
      mediaType: 'image/png',
      byteSize: 68,
      usage,
    }
    const generateImage = vi.fn(
      async (_prompt: string, _signal: AbortSignal, onUsage?: (value: GeneratedImageUsage) => void) => {
        onUsage?.(usage)
        onUsage?.(usage)
        return generated
      }
    )
    const onGeneratedImageUsage = vi.fn()

    await generateImageTool.execute(
      { prompt: 'a teal robot' },
      ctx({ generateImage, onGeneratedImageUsage, emitGeneratedImage: () => {} })
    )

    expect(onGeneratedImageUsage).toHaveBeenCalledOnce()
    expect(onGeneratedImageUsage).toHaveBeenCalledWith(usage)
  })

  it('preserves usage when generation fails before creating an asset', async () => {
    const usage: GeneratedImageUsage = {
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 40,
      output: 3,
    }
    const onGeneratedImageUsage = vi.fn()
    const generateImage = vi.fn(
      async (_prompt: string, _signal: AbortSignal, onUsage?: (value: GeneratedImageUsage) => void) => {
        onUsage?.(usage)
        throw new Error('image runtime failed')
      }
    )

    await expect(
      generateImageTool.execute(
        { prompt: 'a teal robot' },
        ctx({ generateImage, onGeneratedImageUsage, emitGeneratedImage: () => {} })
      )
    ).rejects.toThrow('image runtime failed')
    expect(onGeneratedImageUsage).toHaveBeenCalledOnce()
  })

  it('preserves usage when aborted before creating an asset', async () => {
    const usage: GeneratedImageUsage = {
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 40,
      output: 3,
    }
    const controller = new AbortController()
    const onGeneratedImageUsage = vi.fn()
    const generateImage = vi.fn(
      async (_prompt: string, _signal: AbortSignal, onUsage?: (value: GeneratedImageUsage) => void) => {
        onUsage?.(usage)
        controller.abort(new Error('stopped'))
        return {
          artifactId: 'z'.repeat(32),
          name: 'aborted.png',
          mediaType: 'image/png',
          byteSize: 68,
          usage,
        }
      }
    )

    await expect(
      generateImageTool.execute(
        { prompt: 'a teal robot' },
        ctx({
          signal: controller.signal,
          generateImage,
          onGeneratedImageUsage,
          emitGeneratedImage: () => {},
        })
      )
    ).rejects.toThrow('stopped')
    expect(onGeneratedImageUsage).toHaveBeenCalledOnce()
  })

  it('requests edit permission and saves the worktree asset with its actual extension', async () => {
    const cwd = makeWorktree()
    const order: string[] = []
    const ask = vi.fn(async () => {
      order.push('permission')
    })
    h.generateImageForConversation.mockImplementationOnce(async () => {
      order.push('generation')
      return {
        ...(await saveGeneratedImage({ conversationId: 'conv_tool', result: PNG_1X1, label: 'hero' })),
        revisedPrompt: 'A polished landing page hero',
      }
    })
    const emitted: unknown[] = []
    const args = { prompt: 'a landing page hero', outputPath: 'public/images/hero.webp' }

    const result = await generateImageTool.execute(
      args,
      ctx({ cwd, ask, emitGeneratedImage: (image) => emitted.push(image) })
    )
    const text = generateImageTool.toModelText(args, result)

    expect(order).toEqual(['permission', 'generation'])
    expect(ask).toHaveBeenCalledWith(
      'edit',
      [
        path.join(cwd, 'public/images/hero.webp'),
        path.join(cwd, 'public/images/hero.png'),
        path.join(cwd, 'public/images/hero.jpg'),
        path.join(cwd, 'public/images/hero.gif'),
      ],
      ['*']
    )
    expect(result).toMatchObject({ outputPath: 'public/images/hero.png', overwritten: false })
    expect(readFileSync(path.join(cwd, 'public/images/hero.png'))).toEqual(Buffer.from(PNG_1X1, 'base64'))
    expect(emitted).toHaveLength(1)
    expect(text).toContain('public/images/hero.png')
    expect(text).toContain('Use this exact relative path')
    expect(text).not.toContain(PNG_1X1.slice(0, 16))
  })

  it('avoids edit permission and worktree files in chat-only mode', async () => {
    const cwd = makeWorktree()
    const ask = vi.fn(async () => {})
    const generated = {
      artifactId: 'c'.repeat(32),
      name: 'preview.png',
      mediaType: 'image/png',
      byteSize: 68,
    }
    h.generateImageForConversation.mockResolvedValueOnce(generated)

    const result = await generateImageTool.execute(
      { prompt: 'preview only' },
      ctx({ cwd, ask, emitGeneratedImage: () => {} })
    )

    expect(ask).not.toHaveBeenCalled()
    expect(result).not.toHaveProperty('outputPath')
    expect(readdirSync(cwd)).toEqual([])
  })

  it('rejects traversal before permission and generation', async () => {
    const ask = vi.fn(async () => {})

    await expect(
      generateImageTool.execute(
        { prompt: 'x', outputPath: '../escape.png' },
        ctx({ cwd: makeWorktree(), ask, emitGeneratedImage: () => {} })
      )
    ).rejects.toThrow(/worktree/i)

    expect(ask).not.toHaveBeenCalled()
    expect(h.generateImageForConversation).not.toHaveBeenCalled()
  })

  it('prevents generation consumption when edit permission is denied', async () => {
    const ask = vi.fn(async () => {
      throw new Error('Permission denied')
    })

    await expect(
      generateImageTool.execute(
        { prompt: 'x', outputPath: 'public/hero.png' },
        ctx({ cwd: makeWorktree(), ask, emitGeneratedImage: () => {} })
      )
    ).rejects.toThrow(/Permission denied/)

    expect(h.generateImageForConversation).not.toHaveBeenCalled()
  })

  it('removes the sidecar on publication failure while preserving the copied project asset', async () => {
    const cwd = makeWorktree()
    const generated = {
      ...(await saveGeneratedImage({ conversationId: 'conv_tool', result: PNG_1X1, label: 'hero' })),
      revisedPrompt: 'Hero art',
    }
    h.generateImageForConversation.mockResolvedValueOnce(generated)

    await expect(
      generateImageTool.execute(
        { prompt: 'hero', outputPath: 'public/hero.png' },
        ctx({
          cwd,
          emitGeneratedImage: () => {
            throw new Error('part publication failed')
          },
        })
      )
    ).rejects.toThrow(/part publication failed/)

    await expect(readGeneratedImage('conv_tool', generated.artifactId)).resolves.toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(existsSync(path.join(cwd, 'public/hero.png'))).toBe(true)
  })

  it('rejects missing runner hooks before subscription use', async () => {
    await expect(generateImageTool.execute({ prompt: 'x' }, ctx())).rejects.toThrow(/not available/i)
  })

  it('publishes generated image parts with toolCallId and forced persistence', () => {
    const events: Array<{ event: ChatStreamEvent; force?: boolean }> = []
    emitGeneratedImagePart((event, force) => events.push({ event, force }), 'msg_1', 'call_1', {
      artifactId: 'b'.repeat(32),
      name: 'robot.png',
      mediaType: 'image/png',
      byteSize: 68,
    })

    expect(events).toEqual([
      {
        event: {
          kind: 'generated-image',
          messageId: 'msg_1',
          partId: 'call_1_image',
          artifactId: 'b'.repeat(32),
          name: 'robot.png',
          mediaType: 'image/png',
          byteSize: 68,
        },
        // Force persistence because the file exists and cannot wait for throttling.
        force: true,
      },
    ])
  })
})

describe('generated-image usage aggregation', () => {
  it('attributes tokens to actual Codex models without invented asset costs', () => {
    const usage = new Map<string, import('../../src/shared/chat').ChatSubagentUsage>()
    mergeGeneratedImageUsage(usage, {
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.6-mini',
      input: 100,
      output: 7,
      cachedInput: 20,
    })

    expect([...usage.values()]).toEqual([
      {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-mini',
        input: 100,
        output: 7,
        cachedInput: 20,
        catalogInput: 100,
        catalogOutput: 7,
        catalogCacheRead: 20,
        catalogCacheCreate: 0,
      },
    ])
  })
})

describe('global and conversation image-generation toggles', () => {
  it('defaults on and lets conversation overrides win', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})

    expect(imageGenEnabledFor(conversation.id)).toBe(true)

    setAppFlag('chat.imageGen', false)
    expect(imageGenEnabledFor(conversation.id)).toBe(false)

    patchConvUiPrefs(conversation.id, { chat: { tools: { imageGen: true } } })
    expect(imageGenEnabledFor(conversation.id)).toBe(true)

    patchConvUiPrefs(conversation.id, { chat: { tools: { imageGen: false } } })
    setAppFlag('chat.imageGen', true)
    expect(imageGenEnabledFor(conversation.id)).toBe(false)
  })

  it('does not hide the tool when passive runtime readiness is missing', async () => {
    setAppPackaged(true)
    h.readyRuntimeAsset.mockRejectedValue(new Error('codex runtime is not installed'))
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})

    await expect(generateImageToolEnabled(conversation.id, 'agent')).resolves.toBe(true)
    await expect(generateImageToolEnabled(conversation.id, 'design')).resolves.toBe(true)
    expect(h.readyRuntimeAsset).not.toHaveBeenCalled()
  })

  it('offers the tool only in Agent with toggle enabled and an account connected', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, {})

    await expect(generateImageToolEnabled(conversation.id, 'agent')).resolves.toBe(true)
    // Plan and Ask are read-only and cannot create artifacts.
    await expect(generateImageToolEnabled(conversation.id, 'plan')).resolves.toBe(false)
    await expect(generateImageToolEnabled(conversation.id, 'ask')).resolves.toBe(false)

    setAppFlag('chat.imageGen', false)
    await expect(generateImageToolEnabled(conversation.id, 'agent')).resolves.toBe(false)
    setAppFlag('chat.imageGen', true)

    // Without connected ChatGPT credentials the model never sees the tool.
    h.authenticated = false
    await expect(generateImageToolEnabled(conversation.id, 'agent')).resolves.toBe(false)
  })
})
