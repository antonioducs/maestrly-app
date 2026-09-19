import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@cursor/sdk'
import type {
  CursorSubscriptionAccountIdentity,
  CursorSubscriptionManager,
} from '../../src/main/chat/cursor-subscription/manager'
import { summarizeWithCursorRuntime } from '../../src/main/chat/cursor-subscription/portable-summarizer'
import { listCursorAgentCleanup } from '../../src/main/chat/cursor-subscription/session-store'
import { resolveCursorModelAxes, type CursorModelCatalogEntry } from '../../src/main/chat/cursor-sdk/models'
import { closeDb, freshDb } from '../helpers/db'

const SPEED_AXIS_CATALOG: CursorModelCatalogEntry[] = [
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    parameters: [{ id: 'speed', values: [{ value: 'fast' }, { value: 'standard' }] }],
  },
]

type Script = () => AsyncGenerator<SDKMessage, void>

const identity: CursorSubscriptionAccountIdentity = { fingerprint: 'user:7', epoch: 3 }

function msg(type: string, data: Record<string, unknown>): SDKMessage {
  return { type, agent_id: 'summarizer-agent', run_id: 'run-1', ...data } as unknown as SDKMessage
}

class FakeRun {
  readonly cancel: ReturnType<typeof vi.fn>
  constructor(
    private readonly script: Script,
    private readonly waitStatus = 'finished'
  ) {
    this.cancel = vi.fn(async () => undefined)
  }
  supports(op: string): boolean {
    return op === 'stream' || op === 'wait' || op === 'cancel'
  }
  stream(): AsyncGenerator<SDKMessage, void> {
    return this.script()
  }
  async wait(): Promise<{ id: string; status: string }> {
    return { id: 'run-1', status: this.waitStatus }
  }
}

class FakeAgent {
  readonly close = vi.fn()
  readonly sendOptions: unknown[] = []
  readonly send: (message: unknown, options?: unknown) => Promise<FakeRun>
  constructor(
    readonly agentId: string,
    runFactory: () => FakeRun,
    sendError: () => unknown
  ) {
    const inner = async (): Promise<FakeRun> => runFactory()
    this.send = async (_message: unknown, options?: unknown) => {
      this.sendOptions.push(options)
      const error = sendError()
      if (error) throw error
      return inner()
    }
  }
}

class FakeManager {
  readonly accountId: string | null = null
  readonly assertAccountIdentity = vi.fn((expected: CursorSubscriptionAccountIdentity) => {
    if (expected.fingerprint !== identity.fingerprint || expected.epoch !== identity.epoch) {
      throw new Error('account changed')
    }
  })
  readonly deleteAgent = vi.fn(async () => undefined)

  readonly resolveModelSelection = vi.fn(
    async (modelId: string, fastMode?: boolean, _force?: boolean, reasoningEffort?: string | null) => {
      const resolved = resolveCursorModelAxes(this.models, { modelId, fastMode, reasoningEffort })
      if (!resolved.ok) throw new Error(resolved.error)
      return {
        modelId: resolved.resolution.selection.id,
        params: resolved.resolution.canonicalParams,
        note: resolved.resolution.note,
      }
    }
  )
  private models: CursorModelCatalogEntry[] = SPEED_AXIS_CATALOG
  setModels(models: CursorModelCatalogEntry[]): void {
    this.models = models
  }
  private sendError: unknown = null
  private readonly runs: FakeRun[] = []
  private readonly pending: Array<{ script: Script; waitStatus: string }> = []
  queue(script: Script, waitStatus = 'finished'): void {
    this.pending.push({ script, waitStatus })
  }
  failSend(error: unknown): void {
    this.sendError = error
  }
  lastRun(): FakeRun | undefined {
    return this.runs.at(-1)
  }
  private lastAgentRef: FakeAgent | null = null
  lastAgent(): FakeAgent | null {
    return this.lastAgentRef
  }
  async createAgent(): Promise<{ agent: FakeAgent; release: ReturnType<typeof vi.fn> }> {
    const agent = new FakeAgent(
      'summarizer-agent',
      () => {
        const next = this.pending.shift() ?? {
          script: async function* () {} as Script,
          waitStatus: 'finished',
        }
        const run = new FakeRun(next.script, next.waitStatus)
        this.runs.push(run)
        return run
      },
      () => this.sendError
    )
    this.lastAgentRef = agent
    return { agent, release: vi.fn() }
  }
}

describe('Cursor portable summarizer', () => {
  beforeEach(() => {
    freshDb()
  })

  afterEach(() => {
    closeDb()
  })

  it('returns text and usage and deletes the ephemeral agent', async () => {
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'resumo ok' }] },
      })
      yield msg('usage', { usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } })
      yield msg('status', { status: 'FINISHED' })
    })

    const result = await summarizeWithCursorRuntime({
      manager: manager as unknown as CursorSubscriptionManager,
      accountIdentity: identity,
      cwd: '/repo',
      modelId: 'composer-2.5',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
    })
    expect(result.text).toBe('resumo ok')
    expect(result.usage).toEqual({
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheCreate: 0,
      totalInput: 100,
    })

    expect(result.runtimeEstimatedCostUsd).toBeUndefined()
    expect(manager.deleteAgent).toHaveBeenCalledWith('summarizer-agent')
    expect(listCursorAgentCleanup()).toHaveLength(0)
  })

  it('passes explicit Fast parameters without inventing a price estimate', async () => {
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'resumo fast' }] },
      })
      yield msg('usage', { usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } })
      yield msg('status', { status: 'FINISHED' })
    })

    const result = await summarizeWithCursorRuntime({
      manager: manager as unknown as CursorSubscriptionManager,
      accountIdentity: identity,
      cwd: '/repo',
      modelId: 'composer-2.5',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
      fastMode: true,
    })

    const sendOptions = manager.lastAgent()?.sendOptions[0] as { model?: { id: string; params?: unknown[] } }
    expect(sendOptions?.model).toEqual({ id: 'composer-2.5', params: [{ id: 'speed', value: 'fast' }] })

    expect(result.runtimeEstimatedCostUsd).toBeUndefined()
  })

  it('passes explicit Standard parameters without inventing a price estimate', async () => {
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'resumo standard' }] },
      })
      yield msg('usage', { usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } })
      yield msg('status', { status: 'FINISHED' })
    })

    const result = await summarizeWithCursorRuntime({
      manager: manager as unknown as CursorSubscriptionManager,
      accountIdentity: identity,
      cwd: '/repo',
      modelId: 'composer-2.5',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
      fastMode: false,
    })
    const sendOptions = manager.lastAgent()?.sendOptions[0] as { model?: { id: string; params?: unknown[] } }
    expect(sendOptions?.model).toEqual({ id: 'composer-2.5', params: [{ id: 'speed', value: 'standard' }] })

    expect(result.runtimeEstimatedCostUsd).toBeUndefined()
  })

  it('propagates reasoning effort alongside Fast parameters', async () => {
    const manager = new FakeManager()
    manager.setModels([
      {
        ...SPEED_AXIS_CATALOG[0],
        parameters: [
          ...(SPEED_AXIS_CATALOG[0].parameters ?? []),
          { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
        ],
      },
    ])
    manager.queue(async function* () {
      yield msg('assistant', { message: { role: 'assistant', content: [{ type: 'text', text: 'deep summary' }] } })
      yield msg('status', { status: 'FINISHED' })
    })

    await summarizeWithCursorRuntime({
      manager: manager as unknown as CursorSubscriptionManager,
      accountIdentity: identity,
      cwd: '/repo',
      modelId: 'composer-2.5',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
      fastMode: true,
      reasoningEffort: 'high',
    })

    const sendOptions = manager.lastAgent()?.sendOptions[0] as { model?: { id: string; params?: unknown[] } }
    expect(sendOptions.model).toEqual({
      id: 'composer-2.5',
      params: [
        { id: 'reasoning_effort', value: 'high' },
        { id: 'speed', value: 'fast' },
      ],
    })
  })

  it('rejects effective Cursor parameter drift against the frozen isolated snapshot', async () => {
    const manager = new FakeManager()
    manager.setModels([
      {
        id: 'composer-2.5',
        displayName: 'Composer 2.5',

        parameters: [{ id: 'latency', values: [{ value: 'fast' }, { value: 'standard' }] }],
      },
    ])

    await expect(
      summarizeWithCursorRuntime({
        manager: manager as unknown as CursorSubscriptionManager,
        accountIdentity: identity,
        cwd: '/repo',
        modelId: 'composer-2.5',
        system: 'system',
        prompt: 'resuma',
        signal: new AbortController().signal,
        fastMode: false,
        frozenModelSelection: { modelId: 'composer-2.5', params: [{ id: 'speed', value: 'standard' }] },
      })
    ).rejects.toThrow('executor-unavailable')
    expect(manager.lastAgent()).toBeNull()
  })

  it('rejects Fast mode when the catalog does not offer that axis', async () => {
    const manager = new FakeManager()
    manager.setModels([{ id: 'composer-2.5', displayName: 'Composer 2.5' }])
    await expect(
      summarizeWithCursorRuntime({
        manager: manager as unknown as CursorSubscriptionManager,
        accountIdentity: identity,
        cwd: '/repo',
        modelId: 'composer-2.5',
        system: 'system',
        prompt: 'resuma',
        signal: new AbortController().signal,
        fastMode: true,
      })
    ).rejects.toThrow(/no Fast\/speed parameter/)
  })

  it('redacts credentials in raw SDK errors', async () => {
    const manager = new FakeManager()
    const secret = 'crsr_live_AbCdEf1234567890'
    const keySecret = 'key_ZZZyyyxxx111222333'
    manager.failSend(new Error(`request failed: Authorization: Bearer ${secret} (apiKey=${keySecret})`))

    const thrown = await summarizeWithCursorRuntime({
      manager: manager as unknown as CursorSubscriptionManager,
      accountIdentity: identity,
      cwd: '/repo',
      modelId: 'composer-2.5',
      system: 'system',
      prompt: 'resuma',
      signal: new AbortController().signal,
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message).not.toContain(secret)
    expect(message).not.toContain(keySecret)
    expect(message).toContain('[REDACTED]')

    expect(manager.deleteAgent).toHaveBeenCalledWith('summarizer-agent')
  })

  it('preserves abort semantics with a sanitized error', async () => {
    const controller = new AbortController()
    const manager = new FakeManager()
    manager.queue(async function* () {
      yield msg('assistant', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'parcial' }] },
      })
      controller.abort()
      await new Promise<never>(() => {})
    })

    await expect(
      summarizeWithCursorRuntime({
        manager: manager as unknown as CursorSubscriptionManager,
        accountIdentity: identity,
        cwd: '/repo',
        modelId: 'composer-2.5',
        system: 'system',
        prompt: 'resuma',
        signal: controller.signal,
        watchdog: { timeoutMs: 10_000, graceMs: 25 },
      })
    ).rejects.toThrow('aborted')
    expect(controller.signal.aborted).toBe(true)
    expect(manager.lastRun()!.cancel).toHaveBeenCalledTimes(1)
    expect(manager.deleteAgent).toHaveBeenCalledWith('summarizer-agent')
  })
})
