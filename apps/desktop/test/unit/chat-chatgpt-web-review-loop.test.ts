import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_ITERATIONS,
  HARD_MAX_ITERATIONS,
  MAX_FINDINGS,
  MAX_FINDINGS_TOTAL_CHARS,
  createReviewLoopController,
  fingerprintOf,
  validateFindingsShape,
  type BridgeReviewEvidence,
  type ReviewLoopDeps,
  type ReviewFindingInput,
  type WorkspaceSnapshot,
} from '../../src/main/chat/chatgpt-web/review-loop'
import { PreviewStartupError } from '../../src/main/chat/chatgpt-web/preview-runtime'
import type { FrozenChatSelection, InternalTurnHandle, InternalTurnOutcome } from '../../src/shared/chat'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'review-loop-'))
  writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture"}\n')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

const SELECTION: FrozenChatSelection = { providerId: 'builtin_codex', modelId: 'gpt-5.6', fastMode: false }

function finding(id: string, severity: ReviewFindingInput['severity'] = 'blocking'): ReviewFindingInput {
  return { id, severity, title: `finding ${id}`, details: `details of ${id}` }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function evidence(iteration: number): BridgeReviewEvidence {
  return { contextLoaded: true, byIteration: { [iteration]: { diff: 1, search: 1, read: 1 } }, checks: ['test'] }
}

function startArgs(
  overrides: Partial<{
    reviewScope: 'code' | 'frontend'
    previewId: string
    browserId: string
    maxIterations: number
    severityThreshold: 'blocking' | 'important'
    idempotencyKey: string
  }> = {}
) {
  return { maxIterations: 5, severityThreshold: 'important' as const, idempotencyKey: 'start-key-001', ...overrides }
}

function finishArgs(
  loopId: string,
  overrides: Partial<{
    result: 'clean' | 'max_iterations' | 'no_progress' | 'failed' | 'cancelled'
    summary: string
    remainingFindings: Array<{ severity: ReviewFindingInput['severity']; title: string; details: string }>
    idempotencyKey: string
  }> = {}
) {
  return { loopId, result: 'clean' as const, summary: 'Review summary', idempotencyKey: 'finish-key-001', ...overrides }
}

type ControllerHarness = ReturnType<typeof makeController>

/** Harness: fake git, turns resolved on demand, and no pending teardown timers. */
function makeController(overrides: Partial<ReviewLoopDeps> = {}) {
  let clock = 1000
  const now = () => clock
  const advance = (ms: number) => {
    clock += ms
  }
  const gitFiles: Record<string, string> = {}
  const runGit = vi.fn(async (args: string[]) => {
    const key = args.join(' ')
    if (key === 'rev-parse --abbrev-ref HEAD') return 'main'
    if (key === 'rev-parse HEAD') return 'abc123'
    if (key === 'ls-files --others --exclude-standard') return ''
    return gitFiles[key] ?? ''
  })
  const setGit = (key: string, value: string) => {
    gitFiles[key] = value
  }
  const persistSummary = vi.fn(async ({ loopId }: { loopId: string; markdown: string }) => ({
    ok: true as const,
    messageId: `review-loop-summary:${loopId}`,
  }))
  const forceAgentMode = vi.fn()
  const setReviewIteration = vi.fn()
  const clearReviewIteration = vi.fn()
  const forgetReviewLoop = vi.fn()
  const getBridgeEvidence = vi.fn((_loopId: string): BridgeReviewEvidence => evidence(1))
  const sessionActive = vi.fn(() => true)
  const validateStart = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }))
  const resolveSelection = vi.fn(
    async (): Promise<{ ok: true; selection: FrozenChatSelection } | { ok: false; error: string }> => ({
      ok: true,
      selection: SELECTION,
    })
  )
  const cancelTurn = vi.fn()

  const turns: Array<{ settle: (outcome: InternalTurnOutcome) => void; cancel: () => void }> = []
  const startTurn = vi.fn(
    async ({
      selection,
    }: {
      selection: FrozenChatSelection
      iteration?: number
      maxIterations?: number
      prompt?: string
      hiddenParts?: unknown
      loopId?: string
      signal?: AbortSignal
    }): Promise<{ ok: true; handle: InternalTurnHandle }> => {
      let settle!: (outcome: InternalTurnOutcome) => void
      let cancel = () => undefined
      const done = new Promise<InternalTurnOutcome>((resolve) => {
        settle = resolve
      })
      const entry = { settle, cancel: () => cancel() }
      turns.push(entry)
      const handle: InternalTurnHandle = {
        executionId: `exec-${turns.length}`,
        conversationId: 'conv-1',
        assistantMessageId: () => `assistant-${turns.length}`,
        done,
        cancel: () => entry.cancel(),
      }
      cancel = () => {
        settle({ status: 'cancelled', assistantMessageId: null })
      }
      void selection
      return { ok: true as const, handle }
    }
  )

  const controller = createReviewLoopController({
    conversationId: 'conv-1',
    cwd: repo,
    sessionKeyHash: 'hash',
    now,
    runGit,
    sessionActive,
    validateStart,
    resolveSelection,
    startTurn,
    cancelTurn,
    getBridgeEvidence,
    setReviewIteration,
    clearReviewIteration,
    forgetReviewLoop,
    persistSummary,
    forceAgentMode,
    ...overrides,
  })

  return {
    controller,
    now,
    advance,
    runGit,
    setGit,
    persistSummary,
    forceAgentMode,
    setReviewIteration,
    clearReviewIteration,
    forgetReviewLoop,
    getBridgeEvidence,
    sessionActive,
    validateStart,
    resolveSelection,
    cancelTurn,
    turns,
    startTurn,
  }
}

/** Start with defaults and cast the successful result. */
async function startOk(h: ControllerHarness) {
  const result = await h.controller.start(startArgs())
  expect('error' in result).toBe(false)
  return result as {
    loopId: string
    status: 'reviewing'
    iteration: number
    maxIterations: number
    severityThreshold: 'blocking' | 'important'
    reviewScope: 'code' | 'frontend'
    baseline: { branch: string; head: string; workspaceFingerprint: string }
    executor: { providerId: string; modelId: string; reasoning?: string }
  }
}

/** Runs ONE complete round: submit, optional workspace change, turn resolution, then job completion. */
async function runRound(
  h: ControllerHarness,
  loopId: string,
  iteration: number,
  key: string,
  change?: () => void
): Promise<string> {
  const sub = await h.controller.submit({
    loopId,
    iteration,
    findings: [finding(`f${iteration}`)],
    idempotencyKey: key,
  })
  expect('error' in sub).toBe(false)
  const jobId = (sub as { jobId: string }).jobId
  change?.()
  const turn = h.turns[h.turns.length - 1]
  turn.settle({ status: 'success', assistantMessageId: `assistant-${iteration}` })
  await vi.waitFor(() => {
    const st = h.controller.getState()
    // The job left running: finalized and removed from state or marked completed.
    expect(st?.activeJob == null || st.activeJob.jobId !== jobId || st.activeJob.status !== 'running').toBe(true)
  })
  return jobId
}

describe('review loop controller', () => {
  it('holds cancelled loop slots until visual teardown completes', async () => {
    const browserClosed = deferred()
    const previewClosed = deferred()
    const h = makeController({
      prepareFrontendEnvironment: async () => ({
        preview: { url: 'http://127.0.0.1:5173/', managed: true, dispose: () => previewClosed.promise },
        browser: {
          info: () => ({ state: 'ready', url: 'http://127.0.0.1:5173/' }),
          show: () => true,
          dispose: () => browserClosed.promise,
        } as never,
      }),
    })
    const started = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview-approved' }))
    const loopId = (started as { loopId: string }).loopId

    h.controller.cancel('cancelled')
    expect(h.controller.activeLoopId()).toBe(loopId)
    expect(h.controller.info()).toMatchObject({ loopId, status: 'cancelled' })
    expect(await h.controller.start(startArgs({ idempotencyKey: 'stopping-start-001' }))).toEqual({
      error: 'review-loop-stopping',
    })

    browserClosed.resolve()
    previewClosed.resolve()
    await vi.waitFor(() => expect(h.controller.activeLoopId()).toBeNull())
    expect(await h.controller.start(startArgs({ idempotencyKey: 'stopping-start-002' }))).not.toHaveProperty('error')
  })

  it('awaits visual teardown before releasing automatically ended loops', async () => {
    const browserClosed = deferred()
    const previewClosed = deferred()
    const h = makeController({
      getBridgeEvidence: () => ({
        contextLoaded: true,
        byIteration: { 1: { diff: 1, search: 1, read: 1, browserSnapshot: 1, browserScreenshot: 1 } },
        checks: [],
      }),
      prepareFrontendEnvironment: async () => ({
        preview: { url: 'http://127.0.0.1:5173/', managed: true, dispose: () => previewClosed.promise },
        browser: {
          info: () => ({ state: 'ready', url: 'http://127.0.0.1:5173/' }),
          show: () => true,
          dispose: () => browserClosed.promise,
        } as never,
      }),
    })
    const started = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview-approved' }))
    const loopId = (started as { loopId: string }).loopId
    const submitted = await h.controller.submit({
      loopId,
      iteration: 1,
      findings: [finding('automatic-terminal')],
      idempotencyKey: 'automatic-terminal-submit-001',
    })
    expect('error' in submitted).toBe(false)

    h.turns[0].settle({ status: 'error', error: 'provider failed', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.finishReason).toBe('failed'))
    expect(await h.controller.start(startArgs({ idempotencyKey: 'automatic-terminal-start-001' }))).toEqual({
      error: 'review-loop-stopping',
    })

    browserClosed.resolve()
    previewClosed.resolve()
    await vi.waitFor(() => expect(h.controller.activeLoopId()).toBeNull())
    expect(await h.controller.start(startArgs({ idempotencyKey: 'automatic-terminal-start-002' }))).not.toHaveProperty(
      'error'
    )
  })

  it('prepares frontend environments before locks and cleans startup failures', async () => {
    const prepareFrontendEnvironment = vi.fn(async () => {
      throw new Error('preview timeout')
    })
    const h = makeController({ prepareFrontendEnvironment })
    const result = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_ok' }))
    expect(result).toEqual({ error: 'frontend-preview-start-failed:preview timeout' })
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.setReviewIteration).not.toHaveBeenCalled()
  })

  it('bounds frontend preparation and aborts bootstrap before reservation', async () => {
    let startupSignal: AbortSignal | undefined
    const prepareFrontendEnvironment = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>(() => {
          startupSignal = signal
        })
    )
    const h = makeController({ prepareFrontendEnvironment, frontendStartupTimeoutMs: 10 })

    const result = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_hung' }))

    expect(result).toEqual({
      error: 'frontend-preview-start-failed:Visual review bootstrap timed out after 10ms.',
    })
    expect(startupSignal?.aborted).toBe(true)
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.setReviewIteration).not.toHaveBeenCalled()
  })

  it('cleans late frontend handles after timeout', async () => {
    const previewDispose = vi.fn(async () => undefined)
    const browserDispose = vi.fn(async () => undefined)
    let resolvePrepared!: (value: {
      preview: { url: string; managed: true; dispose: () => Promise<void> }
      browser: { dispose: () => Promise<void> }
    }) => void
    const prepared = new Promise<{
      preview: { url: string; managed: true; dispose: () => Promise<void> }
      browser: { dispose: () => Promise<void> }
    }>((resolve) => {
      resolvePrepared = resolve
    })
    const h = makeController({
      prepareFrontendEnvironment: vi.fn(() => prepared as never),
      frontendStartupTimeoutMs: 10,
    })

    await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_late' }))
    resolvePrepared({
      preview: { url: 'http://localhost:5173/', managed: true, dispose: previewDispose },
      browser: { dispose: browserDispose },
    })

    await vi.waitFor(() => {
      expect(browserDispose).toHaveBeenCalledOnce()
      expect(previewDispose).toHaveBeenCalledOnce()
    })
    expect(h.controller.activeLoopId()).toBeNull()
  })

  it('returns sanitized preview process diagnostics', async () => {
    const prepareFrontendEnvironment = vi.fn(async () => {
      throw new PreviewStartupError(
        `Preview failed in ${repo}.`,
        'Authorization: Bearer secret-token-123\nVITE_API_KEY=super-secret-value\nError: missing module'
      )
    })
    const h = makeController({ prepareFrontendEnvironment })

    const result = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_failed' }))
    expect(result).toHaveProperty('error')
    const detail = (result as { error: string }).error
    expect(detail).toContain('Preview failed in <workspace>.')
    expect(detail).toContain('Process output (tail):')
    expect(detail).toContain('Error: missing module')
    expect(detail).not.toContain(repo)
    expect(detail).not.toContain('secret-token-123')
    expect(detail).not.toContain('super-secret-value')
  })

  it('starts the frontend loop with a reviewable browser error surface', async () => {
    const h = makeController({
      prepareFrontendEnvironment: async () => ({
        preview: {
          url: 'http://localhost:3000/',
          managed: true,
          dispose: vi.fn(async () => undefined),
        },
        browser: {
          info: () => ({ state: 'error', url: 'http://localhost:3000/' }),
          show: () => true,
          dispose: vi.fn(async () => undefined),
        } as never,
      }),
    })

    const started = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_redirect_loop' }))

    expect(started).not.toHaveProperty('error')
    expect(h.controller.info()).toMatchObject({
      status: 'reviewing',
      visual: { state: 'error', url: 'http://localhost:3000/', managedPreview: true },
    })
    expect(h.controller.visualBrowser()).not.toBeNull()
    h.controller.dispose()
  })

  it('uses attached user-owned tabs without managed preview requirements', async () => {
    const browserDispose = vi.fn(async () => undefined)
    const prepareAttachedFrontendEnvironment = vi.fn(async () => ({
      ownership: 'attached' as const,
      url: 'http://localhost:5173/game',
      browser: {
        info: () => ({ state: 'ready' as const, url: 'http://localhost:5173/game' }),
        show: () => true,
        dispose: browserDispose,
      } as never,
    }))
    const h = makeController({ prepareAttachedFrontendEnvironment })

    expect(
      await h.controller.start(
        startArgs({
          reviewScope: 'frontend',
          previewId: 'managed',
          browserId: 'attached',
        })
      )
    ).toEqual({ error: 'frontend-environment-conflict' })

    const started = await h.controller.start(
      startArgs({
        reviewScope: 'frontend',
        browserId: 'browser_opaque',
        idempotencyKey: 'attached-start-001',
      })
    )
    expect(started).toMatchObject({
      reviewScope: 'frontend',
      visual: { url: 'http://localhost:5173/game', managedPreview: false },
    })
    expect(prepareAttachedFrontendEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        browserId: 'browser_opaque',
      })
    )
    expect(h.controller.info()).toMatchObject({ visual: { managedPreview: false } })

    h.controller.cancel('cancelled')
    await vi.waitFor(() => expect(h.controller.activeLoopId()).toBeNull())
    expect(browserDispose).toHaveBeenCalledOnce()
  })

  it('tears down a ready visual environment when its preview process exits', async () => {
    const exited = deferred()
    const previewDispose = vi.fn(async () => undefined)
    const browserDispose = vi.fn(async () => undefined)
    const h = makeController({
      prepareFrontendEnvironment: async () => ({
        preview: {
          url: 'http://localhost:5173/',
          managed: true,
          waitForExit: () => exited.promise.then(() => new PreviewStartupError('preview exited', 'fatal')),
          dispose: previewDispose,
        },
        browser: {
          info: () => ({ state: 'ready', url: 'http://localhost:5173/' }),
          show: () => true,
          dispose: browserDispose,
        } as never,
      }),
    })
    const started = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_exit' }))
    expect(started).not.toHaveProperty('error')

    exited.resolve()
    await vi.waitFor(() => {
      expect(browserDispose).toHaveBeenCalledOnce()
      expect(previewDispose).toHaveBeenCalledOnce()
    })
    expect(h.controller.info()).toMatchObject({ visual: { state: 'error', managedPreview: true } })
    expect(h.controller.visualBrowser()).toBeNull()
  })

  it('requires fresh snapshots and screenshots without universal interaction', async () => {
    const previewDispose = vi.fn(async () => undefined)
    const browserDispose = vi.fn(async () => undefined)
    const browserInfo = { state: 'ready' as const, url: 'http://localhost:5173/' }
    let currentEvidence: BridgeReviewEvidence = {
      contextLoaded: true,
      byIteration: { 1: { diff: 1, search: 1, read: 1 } },
      checks: [],
    }
    const h = makeController({
      getBridgeEvidence: () => currentEvidence,
      prepareFrontendEnvironment: async () => ({
        preview: { url: 'http://localhost:5173/', managed: true, dispose: previewDispose },
        browser: { info: () => browserInfo, show: () => true, dispose: browserDispose } as never,
      }),
    })
    const started = await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview_ok' }))
    expect('error' in started).toBe(false)
    const loopId = (started as { loopId: string }).loopId
    const base = { loopId, iteration: 1, findings: [finding('visual')], idempotencyKey: 'visual-submit-001' }
    expect(await h.controller.submit(base)).toEqual({ error: 'insufficient-browser-snapshot' })

    currentEvidence = {
      ...currentEvidence,
      byIteration: { 1: { diff: 1, search: 1, read: 1, browserSnapshot: 1 } },
    }
    expect(await h.controller.submit({ ...base, idempotencyKey: 'visual-submit-002' })).toEqual({
      error: 'insufficient-browser-screenshot',
    })

    currentEvidence = {
      ...currentEvidence,
      byIteration: { 1: { diff: 1, search: 1, read: 1, browserSnapshot: 1, browserScreenshot: 1 } },
    }
    const submitted = await h.controller.submit({ ...base, idempotencyKey: 'visual-submit-003' })
    expect('error' in submitted).toBe(false)
    expect(h.controller.info()).toMatchObject({ reviewScope: 'frontend', visual: { managedPreview: true } })

    h.turns[0].settle({ status: 'success', assistantMessageId: 'assistant-visual' })
    await vi.waitFor(() => expect(h.controller.info()?.iteration).toBe(2))
    // Visual evidence from iteration 1 never satisfies iteration 2.
    currentEvidence = {
      contextLoaded: true,
      byIteration: {
        1: { diff: 1, search: 1, read: 1, browserSnapshot: 1, browserScreenshot: 1 },
        2: { diff: 1, search: 1, read: 1 },
      },
      checks: [],
    }
    expect(await h.controller.finish(finishArgs(loopId))).toEqual({ error: 'insufficient-browser-snapshot' })
    currentEvidence.byIteration[2] = {
      diff: 1,
      search: 1,
      read: 1,
      browserSnapshot: 1,
      browserScreenshot: 1,
    }
    expect(await h.controller.finish(finishArgs(loopId, { idempotencyKey: 'finish-visual-002' }))).toMatchObject({
      result: 'clean',
    })
    expect(browserDispose).toHaveBeenCalledTimes(1)
    expect(previewDispose).toHaveBeenCalledTimes(1)
  })

  it('rejects preview options for code scope while retaining investigation gates', async () => {
    const h = makeController()
    expect(await h.controller.start(startArgs({ previewId: 'forged' }))).toEqual({
      error: 'preview-options-require-frontend',
    })
    const started = await startOk(h)
    expect(started.reviewScope).toBe('code')
    const submitted = await h.controller.submit({
      loopId: started.loopId,
      iteration: 1,
      findings: [finding('code-only')],
      idempotencyKey: 'code-only-submit',
    })
    expect('error' in submitted).toBe(false)
  })

  it('rejects raw target URLs and requires opaque preview IDs', async () => {
    const h = makeController()
    const result = await h.controller.start({
      ...startArgs({ reviewScope: 'frontend' }),
      targetUrl: 'http://127.0.0.1:8080/admin',
    } as never)
    expect(result).toEqual({ error: 'target-url-not-allowed' })
    expect(h.controller.activeLoopId()).toBeNull()
  })

  it('makes preview and browser disposal idempotent', async () => {
    const previewDispose = vi.fn(async () => undefined)
    const browserDispose = vi.fn(async () => undefined)
    const h = makeController({
      prepareFrontendEnvironment: async () => ({
        preview: { url: 'http://127.0.0.1:5173/', managed: true, dispose: previewDispose },
        browser: {
          info: () => ({ state: 'ready', url: 'http://127.0.0.1:5173/' }),
          show: () => true,
          dispose: browserDispose,
        } as never,
      }),
    })
    await h.controller.start(startArgs({ reviewScope: 'frontend', previewId: 'preview-approved' }))
    h.controller.cancel('cancelled')
    h.controller.cancel('cancelled')
    h.controller.dispose()
    await vi.waitFor(() => expect(browserDispose).toHaveBeenCalledTimes(1))
    expect(previewDispose).toHaveBeenCalledTimes(1)
    expect(h.controller.activeLoopId()).toBeNull()
  })

  it('captures baselines and frozen selection on valid start', async () => {
    const h = makeController()
    h.setGit('diff --no-ext-diff --no-textconv', 'change A')
    const started = await startOk(h)
    expect(started.maxIterations).toBe(DEFAULT_MAX_ITERATIONS)
    expect(started.iteration).toBe(1)
    expect(started.executor).toEqual({ providerId: 'builtin_codex', modelId: 'gpt-5.6' })
    expect(started.baseline).toEqual({
      branch: 'main',
      head: 'abc123',
      workspaceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const state = h.controller.getState()
    expect(state?.baseline.unstaged).toBe('change A')
    expect(state?.expectedWorkspace.unstaged).toBe('change A')
    expect(h.forceAgentMode).toHaveBeenCalled()
    expect(h.setReviewIteration).toHaveBeenCalledWith(started.loopId, 1)
  })

  it('2. defaults to 5, caps at 10, and accepts 1 through 10', async () => {
    expect((await startOk(makeController())).maxIterations).toBe(DEFAULT_MAX_ITERATIONS)
    const h10 = makeController()
    const started10 = await h10.controller.start(startArgs({ maxIterations: 10, idempotencyKey: 'start-key-010' }))
    expect((started10 as { maxIterations: number }).maxIterations).toBe(HARD_MAX_ITERATIONS)
    const h1 = makeController()
    const started1 = await h1.controller.start(startArgs({ maxIterations: 1, idempotencyKey: 'start-key-001' }))
    expect((started1 as { maxIterations: number }).maxIterations).toBe(1)
  })

  it('rejects second loops in the same conversation', async () => {
    const h = makeController()
    await startOk(h)
    const second = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    expect(second).toEqual({ error: 'review-loop-active' })
  })

  it('blocks starts for pending plans and active turns', async () => {
    const pending = makeController({ validateStart: async () => ({ ok: false, error: 'pending-plan' }) })
    expect(await pending.controller.start(startArgs())).toEqual({ error: 'pending-plan' })
    const busy = makeController({ validateStart: async () => ({ ok: false, error: 'no-turn-or-operation' }) })
    expect(await busy.controller.start(startArgs())).toEqual({ error: 'no-turn-or-operation' })
  })

  it('returns the same loop for concurrent idempotent starts', async () => {
    const h = makeController()
    const [a, b] = await Promise.all([h.controller.start(startArgs()), h.controller.start(startArgs())])
    expect('error' in a).toBe(false)
    expect(b).toEqual(a)
    expect((a as { loopId: string }).loopId).toBe(h.controller.getState()?.loopId)
    // Reusing keys with different content fails.
    const conflict = await h.controller.start(startArgs({ maxIterations: 7, idempotencyKey: 'start-key-001' }))
    expect(conflict).toEqual({ error: 'idempotency-conflict' })
  })

  it('requires fresh investigation per iteration', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const submit = () => h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    h.getBridgeEvidence.mockReturnValue({
      contextLoaded: true,
      byIteration: { 1: { diff: 0, search: 1, read: 1 } },
      checks: [],
    })
    expect(await submit()).toEqual({ error: 'insufficient-investigation' })
    h.getBridgeEvidence.mockReturnValue({
      contextLoaded: true,
      byIteration: { 1: { diff: 1, search: 0, read: 1 } },
      checks: [],
    })
    expect(await submit()).toEqual({ error: 'insufficient-investigation' })
    h.getBridgeEvidence.mockReturnValue({
      contextLoaded: true,
      byIteration: { 1: { diff: 1, search: 1, read: 0 } },
      checks: [],
    })
    expect(await submit()).toEqual({ error: 'insufficient-investigation' })
    h.getBridgeEvidence.mockReturnValue(evidence(1))
    expect('error' in (await submit())).toBe(false)
  })

  it('creates one job for concurrent submission retries', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const args = { loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' }
    const [a, b] = await Promise.all([h.controller.submit(args), h.controller.submit(args)])
    expect('error' in a).toBe(false)
    expect(b).toEqual(a)
    expect(h.turns).toHaveLength(1)
    expect(h.controller.getState()?.activeJob?.jobId).toBe((a as { jobId: string }).jobId)
  })

  it('returns running followed by completed wait states', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    // Advance frozen clocks to return running while turns remain pending.
    const firstWait = h.controller.wait({ loopId, jobId, waitSeconds: 10 })
    h.advance(11_000)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await firstWait).toMatchObject({ status: 'running', iteration: 1 })
    h.turns[0].settle({ status: 'success', assistantMessageId: 'assistant-1' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    const completed = (await h.controller.wait({ loopId, jobId, waitSeconds: 10 })) as {
      status: string
      iteration: number
      madeProgress: boolean
      nextIteration: number
      canContinue: boolean
    }
    expect(completed.status).toBe('completed')
    expect(completed.iteration).toBe(1)
    expect(completed.madeProgress).toBe(false)
    expect(completed.nextIteration).toBe(2)
    expect(completed.canContinue).toBe(true)
  })

  it('aborts waits and cancels executors when sessions end', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    const ac = new AbortController()
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 60 }, ac.signal)
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('executing'))
    h.controller.cancel('session_ended')
    ac.abort()
    expect(await waiting).toEqual({ error: 'session-ended' })
    expect(h.cancelTurn).toHaveBeenCalled()
    // Finish jobs to avoid pending promises.
    h.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
  })

  it('holds active-job cancellation until completion', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    // Executing cancellation holds slots until runner outcomes arrive.
    await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    h.controller.cancel('cancelled')
    expect(h.controller.getState()?.status).toBe('cancelling')
    expect(h.controller.activeLoopId()).toBe(loopId) // Lock still occupied.
    expect(
      await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k2' })
    ).toEqual({
      error: 'review-loop-cancelled',
    })
    h.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    expect(h.controller.getState()?.status).toBe('cancelled')
    expect(h.controller.activeLoopId()).toBeNull() // Slot released after the outcome.
  })

  it('preserves state for old jobs and wrong iterations', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    // Reject previous iterations without modifying the advanced loop.
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    expect(
      await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k2' })
    ).toEqual({ error: 'wrong-iteration' })
    // Late old-job responses are harmless because settlement is idempotent.
    h.turns[0].settle({ status: 'error', error: 'too late', assistantMessageId: null })
    expect(h.controller.getState()?.status).toBe('reviewing')
    // Unknown job.
    expect(await h.controller.wait({ loopId, jobId: 'job-old', waitSeconds: 5 })).toEqual({ error: 'unknown-job' })
  })

  it('blocks execution after the iteration limit', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    for (let i = 1; i <= 5; i++) {
      h.getBridgeEvidence.mockReturnValue(evidence(i))
      await runRound(h, loopId, i, `k${i}`, () => h.setGit('diff --no-ext-diff --no-textconv', `change ${i}`))
    }
    const state = h.controller.getState()
    expect(state?.status).toBe('finished')
    expect(state?.finishReason).toBe('max_iterations')
    h.getBridgeEvidence.mockReturnValue(evidence(6))
    expect(
      await h.controller.submit({ loopId, iteration: 6, findings: [finding('f6')], idempotencyKey: 'k6' })
    ).toEqual({ error: 'max-iterations-reached' })
  })

  it('does not terminate immediately after one unchanged round', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    const state = h.controller.getState()
    expect(state?.status).toBe('reviewing')
    expect(state?.noProgressCount).toBe(1)
    expect(state?.iteration).toBe(2)
  })

  it('ends repeated unchanged findings as no progress', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    // Resubmit exactly the same findings after an unchanged round.
    const repeated = await h.controller.submit({
      loopId,
      iteration: 2,
      findings: [finding('f1')],
      idempotencyKey: 'k2',
    })
    expect(repeated).toEqual({ error: 'no-progress-repeat' })
    expect(h.controller.getState()?.finishReason).toBe('no_progress')
  })

  it('15. two consecutive rounds without progress terminate the loop', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    await runRound(h, loopId, 2, 'k2')
    const state = h.controller.getState()
    expect(state?.status).toBe('finished')
    expect(state?.finishReason).toBe('no_progress')
  })

  it('ends loops on external workspace changes between rounds', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    // Something changed OUTSIDE the loop between rounds.
    h.setGit('diff --no-ext-diff --no-textconv', 'external change')
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    expect(
      await h.controller.submit({ loopId, iteration: 2, findings: [finding('f2')], idempotencyKey: 'k2' })
    ).toEqual({ error: 'workspace-changed-externally' })
    expect(h.controller.getState()?.finishReason).toBe('workspace_changed_externally')
  })

  it('reuses frozen selections across rounds', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    // UI selection changes do not replace frozen executors.
    h.resolveSelection.mockResolvedValue({
      ok: true,
      selection: { providerId: 'prov_x', modelId: 'm2', fastMode: false },
    })
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    await runRound(h, loopId, 2, 'k2')
    expect(h.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ selection: SELECTION, iteration: 2, maxIterations: 5 })
    )
  })

  it('keeps frozen Fast independent of live UI', async () => {
    const frozen: FrozenChatSelection = { providerId: 'builtin_codex', modelId: 'gpt-5.6', fastMode: true }
    const h = makeController({
      resolveSelection: vi.fn(async () => ({ ok: true as const, selection: frozen })),
    })
    const loopId = (await startOk(h)).loopId
    expect(h.controller.info()?.fastMode).toBe(true)
    await runRound(h, loopId, 1, 'k1')
    // Fast stays frozen while loops remain active after round one.
    expect(h.controller.info()?.fastMode).toBe(true)
    h.resolveSelection.mockResolvedValue({
      ok: true,
      selection: { providerId: 'builtin_codex', modelId: 'gpt-5.6', fastMode: false },
    })
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    const sub = await h.controller.submit({ loopId, iteration: 2, findings: [finding('f2')], idempotencyKey: 'k2' })
    expect('error' in sub).toBe(false)
    expect(h.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ selection: frozen, iteration: 2 }))
    expect(h.controller.info()?.fastMode).toBe(true)
    h.turns[1].settle({ status: 'success', assistantMessageId: 'assistant-2' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
  })

  it('assigns distinct execution IDs and isolated history to each iteration', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1')
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    await runRound(h, loopId, 2, 'k2')
    expect(h.startTurn).toHaveBeenCalledTimes(2)
    const execIds = h.turns.map((_, i) => `exec-${i + 1}`)
    // Each startTurn returned a handle with a distinct executionId; the store isolates by that id.
    expect(execIds[0]).not.toBe(execIds[1])
    expect(h.startTurn.mock.calls[0][0].iteration).toBe(1)
    expect(h.startTurn.mock.calls[1][0].iteration).toBe(2)
  })

  it('ends unavailable executors without fallback', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    h.startTurn.mockResolvedValueOnce({ ok: false, error: 'no-model' } as never)
    expect(
      await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    ).toEqual({ error: 'executor-unavailable' })
    expect(h.controller.getState()?.finishReason).toBe('executor_unavailable')
  })

  it('requires fresh review before clean finish', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    h.getBridgeEvidence.mockReturnValue({ contextLoaded: true, byIteration: {}, checks: [] })
    expect(await h.controller.finish(finishArgs(loopId))).toEqual({ error: 'insufficient-investigation' })
  })

  it('rejects fabricated terminal results for active loops', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId

    for (const result of ['cancelled', 'failed', 'no_progress'] as const) {
      expect(
        await h.controller.finish(
          finishArgs(loopId, { result, idempotencyKey: `finish-${result}`, summary: `tentativa ${result}` })
        )
      ).toEqual({ error: 'loop-not-terminal' })
    }

    expect(h.controller.activeLoopId()).toBe(loopId)
    expect(h.controller.getState()?.status).toBe('reviewing')
    expect(h.persistSummary).not.toHaveBeenCalled()
  })

  it('20. clean finish rejects remaining blocking or important findings', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const blocked = await h.controller.finish(
      finishArgs(loopId, { remainingFindings: [{ severity: 'blocking', title: 'x', details: 'y' }] })
    )
    expect(blocked).toEqual({ error: 'remaining-blocking-findings' })
    const ok = await h.controller.finish(
      finishArgs(loopId, { remainingFindings: [{ severity: 'optional', title: 'x', details: 'y' }] })
    )
    expect('error' in ok).toBe(false)
    expect(h.persistSummary).toHaveBeenCalled()
    expect(h.persistSummary.mock.calls[0][0]).toMatchObject({
      loopId,
      markdown: expect.stringContaining('Review summary'),
    })
  })

  it('21. teardown leaves no pending promises or jobs', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    h.controller.cancel('cancelled')
    h.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    // Wait never stays pending forever, and the active job disappears.
    expect(await waiting).toMatchObject({ status: 'cancelled' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    expect(h.controller.getState()?.status).toBe('cancelled')
  })

  it('returns completed final cycles through wait', async () => {
    const h = makeController()
    const start = await h.controller.start(startArgs({ maxIterations: 1 }))
    const loopId = (start as { loopId: string }).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    h.turns[0].settle({ status: 'success', assistantMessageId: 'assistant-1' })
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('finished'))
    // Final-cycle terminal jobs remain queryable.
    const waited = await h.controller.wait({ loopId, jobId, waitSeconds: 10 })
    expect(waited).toMatchObject({
      status: 'completed',
      canContinue: false,
      stopReason: 'max_iterations',
      madeProgress: false,
      nextIteration: 2,
    })
  })

  it('returns no-progress terminal jobs through wait', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await runRound(h, loopId, 1, 'k1') // No workspace change: noProgressCount is 1.
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    const job2 = await runRound(h, loopId, 2, 'k2') // No change: no_progress.
    expect(h.controller.getState()?.finishReason).toBe('no_progress')
    const waited = await h.controller.wait({ loopId, jobId: job2, waitSeconds: 10 })
    expect(waited).toMatchObject({ status: 'completed', canContinue: false, stopReason: 'no_progress' })
  })

  it('returns cancelled jobs instead of unknown-job', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    h.controller.cancel('cancelled')
    h.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    expect(await h.controller.wait({ loopId, jobId, waitSeconds: 10 })).toMatchObject({
      status: 'cancelled',
      canContinue: false,
      stopReason: 'cancelled',
    })
  })

  it('cancels late start handles without reviving stopped loops', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let lateHandle: InternalTurnHandle | null = null
    const startTurn = vi.fn(async (): Promise<{ ok: true; handle: InternalTurnHandle }> => {
      await gate // startTurn preflight pending.
      let settle!: (outcome: InternalTurnOutcome) => void
      const done = new Promise<InternalTurnOutcome>((resolve) => {
        settle = resolve
      })
      lateHandle = {
        executionId: 'exec-late',
        conversationId: 'conv-1',
        assistantMessageId: () => null,
        done,
        cancel: () => settle({ status: 'cancelled', assistantMessageId: null }),
      }
      return { ok: true as const, handle: lateHandle }
    })
    const h = makeController({ startTurn })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('executing'))
    const jobId = h.controller.getState()?.activeJob?.jobId as string
    h.controller.cancel('cancelled')
    release() // startTurn responds with a handle AFTER cancellation.
    expect(await subPromise).toEqual({ error: 'review-loop-cancelled' })
    // The handle is cancelled immediately and the job finalized as terminal.
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    expect(h.controller.getState()?.status).toBe('cancelled') // NEVER returns to reviewing.
    expect(await h.controller.wait({ loopId, jobId, waitSeconds: 10 })).toMatchObject({
      status: 'cancelled',
      canContinue: false,
      stopReason: 'cancelled',
    })
  })

  it('prevents execution when start signals are already aborted', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let handleCreated = false
    const startTurn = vi.fn(
      async ({
        signal,
      }: {
        signal: AbortSignal
      }): Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }> => {
        await gate
        if (signal.aborted) return { ok: false as const, error: 'cancelled' } // The service never creates an execution.
        handleCreated = true
        let settle!: (outcome: InternalTurnOutcome) => void
        const done = new Promise<InternalTurnOutcome>((resolve) => {
          settle = resolve
        })
        return {
          ok: true as const,
          handle: {
            executionId: 'exec-x',
            conversationId: 'conv-1',
            assistantMessageId: () => null,
            done,
            cancel: () => settle({ status: 'cancelled', assistantMessageId: null }),
          },
        }
      }
    )
    const h = makeController({ startTurn })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalled())
    h.controller.cancel('cancelled')
    expect(startTurn.mock.calls[0][0].signal.aborted).toBe(true) // The signal arrives already aborted.
    release()
    expect(await subPromise).toEqual({ error: 'review-loop-cancelled' })
    expect(handleCreated).toBe(false) // No execution was created.
    const jobId = h.controller.getState()?.activeJob?.jobId
    expect(jobId).toBeUndefined()
    expect(h.controller.getState()?.status).toBe('cancelled')
  })

  it('bounds terminal job caches by the retention limit', async () => {
    const h = makeController()
    const start = await h.controller.start(startArgs({ maxIterations: 10 }))
    const loopId = (start as { loopId: string }).loopId
    const jobIds: string[] = []
    for (let i = 1; i <= 10; i++) {
      h.getBridgeEvidence.mockReturnValue(evidence(i))
      jobIds.push(
        await runRound(h, loopId, i, `k${i}`, () => h.setGit('diff --no-ext-diff --no-textconv', `change ${i}`))
      )
    }
    expect(h.controller.getState()?.status).toBe('finished')
    expect(h.controller.getState()?.finishReason).toBe('max_iterations')
    // Keep the eight newest jobs and evict the oldest two.
    expect(await h.controller.wait({ loopId, jobId: jobIds[0], waitSeconds: 5 })).toEqual({ error: 'unknown-job' })
    expect(await h.controller.wait({ loopId, jobId: jobIds[1], waitSeconds: 5 })).toEqual({ error: 'unknown-job' })
    expect(await h.controller.wait({ loopId, jobId: jobIds[9], waitSeconds: 5 })).toMatchObject({
      status: 'completed',
      canContinue: false,
      stopReason: 'max_iterations',
    })
  })

  it('keeps generic executor failures terminal and recoverable through wait', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    h.turns[0].settle({ status: 'error', error: 'provider failed', assistantMessageId: 'assistant-1' })
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('finished'))
    expect(h.controller.getState()?.finishReason).toBe('failed')
    // Wait returns the preserved terminal job with its complete contract.
    const waited = await h.controller.wait({ loopId, jobId, waitSeconds: 10 })
    expect(waited).toMatchObject({
      status: 'failed',
      iteration: 1,
      canContinue: false,
      stopReason: 'failed',
      nextIteration: 2,
    })
    // The bounded executorSummary carries the sanitized error message.
    expect((waited as { executorSummary?: string }).executorSummary).toBe('provider failed')
    // Idempotent retries return original results without new execution.
    const retry = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    expect(retry).toMatchObject({ status: 'running', jobId })
    expect(h.turns).toHaveLength(1)
    // Reject new rounds after terminal loop failure.
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    expect(
      await h.controller.submit({ loopId, iteration: 2, findings: [finding('f2')], idempotencyKey: 'k2' })
    ).toEqual({ error: 'review-loop-failed' })
    // Consistent finish persists the audit summary.
    const finished = await h.controller.finish(
      finishArgs(loopId, { result: 'failed', summary: 'Executor failed in round 1' })
    )
    expect('error' in finished).toBe(false)
    expect(finished).toMatchObject({ result: 'failed', finishReason: 'failed', iterations: 1 })
    expect(h.persistSummary).toHaveBeenCalled()
    expect(h.persistSummary.mock.calls[0][0]).toMatchObject({
      loopId,
      markdown: expect.stringContaining('Executor failed in round 1'),
    })
    // Continue rejecting incompatible results.
    expect(
      await h.controller.finish(finishArgs(loopId, { result: 'clean', idempotencyKey: 'finish-key-002' }))
    ).toEqual({ error: 'inconsistent-result' })
    // Wait remains recoverable after finish.
    expect(await h.controller.wait({ loopId, jobId, waitSeconds: 10 })).toMatchObject({
      status: 'failed',
      canContinue: false,
      stopReason: 'failed',
    })
  })

  it('preserves executor-unavailable classification for missing models or keys', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const sub = await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const jobId = (sub as { jobId: string }).jobId
    h.turns[0].settle({ status: 'error', error: 'no-key', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('finished'))
    expect(h.controller.getState()?.finishReason).toBe('executor_unavailable')
    expect(await h.controller.wait({ loopId, jobId, waitSeconds: 10 })).toMatchObject({
      status: 'failed',
      canContinue: false,
      stopReason: 'executor_unavailable',
    })
    // Reject later submissions to ended loops.
    expect(
      await h.controller.submit({ loopId, iteration: 2, findings: [finding('f2')], idempotencyKey: 'k2' })
    ).toEqual({ error: 'executor-unavailable' })
  })

  it('creates fresh loop IDs after clean finish', async () => {
    const h = makeController()
    const first = (await startOk(h)).loopId
    expect(await h.controller.finish(finishArgs(first, { result: 'clean' }))).not.toHaveProperty('error')
    expect(h.controller.activeLoopId()).toBeNull()
    const second = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    expect('error' in second).toBe(false)
    expect((second as { loopId: string }).loopId).not.toBe(first)
  })

  it('allows restart after iteration, progress and failure limits', async () => {
    const h = makeController()
    // max_iterations
    const l1 = ((await h.controller.start(startArgs({ maxIterations: 1, idempotencyKey: 's1' }))) as { loopId: string })
      .loopId
    await runRound(h, l1, 1, 'k1')
    await vi.waitFor(() => expect(h.controller.getState()?.finishReason).toBe('max_iterations'))
    // No progress uses two unchanged rounds with different findings to avoid
    // triggering the no-progress-repeat gate before reaching the actual limit).
    const l2 = ((await h.controller.start(startArgs({ idempotencyKey: 's2' }))) as { loopId: string }).loopId
    await runRound(h, l2, 1, 'k2')
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    const sub2b = await h.controller.submit({
      loopId: l2,
      iteration: 2,
      findings: [finding('f2')],
      idempotencyKey: 'k3',
    })
    expect('error' in sub2b).toBe(false)
    h.turns[h.turns.length - 1].settle({ status: 'success', assistantMessageId: 'a' })
    await vi.waitFor(() => expect(h.controller.getState()?.finishReason).toBe('no_progress'))
    // Generic executor failure.
    h.getBridgeEvidence.mockReturnValue(evidence(1)) // Iteration 1 of the new loop.
    const l3 = ((await h.controller.start(startArgs({ maxIterations: 1, idempotencyKey: 's3' }))) as { loopId: string })
      .loopId
    await h.controller.submit({ loopId: l3, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k4' })
    h.turns[h.turns.length - 1].settle({ status: 'error', error: 'provider failed', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.finishReason).toBe('failed'))
    // All three loops end and the fourth start succeeds.
    const l4 = await h.controller.start(startArgs({ idempotencyKey: 's4' }))
    expect('error' in l4).toBe(false)
    expect((l4 as { loopId: string }).loopId).not.toBe(l1)
    expect((l4 as { loopId: string }).loopId).not.toBe(l2)
    expect((l4 as { loopId: string }).loopId).not.toBe(l3)
  })

  it('releases reviewing slots immediately on cancellation', async () => {
    const h = makeController()
    const first = (await startOk(h)).loopId
    h.controller.cancel('cancelled')
    expect(h.controller.getState()?.status).toBe('cancelled')
    expect(h.controller.activeLoopId()).toBeNull()
    const second = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    expect('error' in second).toBe(false)
    expect((second as { loopId: string }).loopId).not.toBe(first)
  })

  it('blocks restart during cancellation until outcomes arrive', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    h.controller.cancel('cancelled')
    expect(h.controller.getState()?.status).toBe('cancelling')
    expect(h.controller.activeLoopId()).toBe(loopId)
    // New starts during cancellation return specific errors.
    const blocked = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    expect(blocked).toEqual({ error: 'review-loop-stopping' })
    // Runner outcome: cancelling becomes cancelled and releases the slot.
    h.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.activeLoopId()).toBeNull())
    expect(h.controller.getState()?.status).toBe('cancelled')
    const second = await h.controller.start(startArgs({ idempotencyKey: 'start-key-003' }))
    expect('error' in second).toBe(false)
  })

  it('allows old-loop waits while newer loops run', async () => {
    const h = makeController()
    const first = (await startOk(h)).loopId
    const sub = await h.controller.submit({
      loopId: first,
      iteration: 1,
      findings: [finding('f1')],
      idempotencyKey: 'k1',
    })
    const jobId = (sub as { jobId: string }).jobId
    h.turns[0].settle({ status: 'success', assistantMessageId: 'a1' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    h.controller.cancel('cancelled') // reviewing → terminal imediato
    const second = ((await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))) as { loopId: string })
      .loopId
    expect(second).not.toBe(first)
    // Old-loop jobs remain queryable during newer loops.
    const waited = await h.controller.wait({ loopId: first, jobId, waitSeconds: 10 })
    expect(waited).toMatchObject({ status: 'completed', canContinue: false, stopReason: 'cancelled' })
  })

  it('isolates late old-loop finishes from current loops', async () => {
    const h = makeController()
    const first = (await startOk(h)).loopId
    // Loop 1 ends on its own due to failure.
    await h.controller.submit({ loopId: first, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    h.turns[0].settle({ status: 'error', error: 'provider failed', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.finishReason).toBe('failed'))
    // loop 2 ativo
    const second = ((await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))) as { loopId: string })
      .loopId
    // Late finish for loop 1 with the new key: accepted and persisted ONCE.
    const finished1 = await h.controller.finish(
      finishArgs(first, { result: 'failed', summary: 'failed in round 1', idempotencyKey: 'finish-key-001' })
    )
    expect('error' in finished1).toBe(false)
    // Loop 2 remains intact and executes normally.
    const sub2 = await h.controller.submit({
      loopId: second,
      iteration: 1,
      findings: [finding('f1')],
      idempotencyKey: 'k2',
    })
    expect('error' in sub2).toBe(false)
    expect(h.controller.getState()?.loopId).toBe(second)
    expect(h.controller.getState()?.status).toBe('executing')
    expect(h.controller.activeLoopId()).toBe(second)
    // Old-loop finish does not persist twice.
    expect(h.persistSummary).toHaveBeenCalledTimes(1)
  })

  it('persists one canonical summary across different finish keys', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const first = await h.controller.finish(finishArgs(loopId, { result: 'clean', idempotencyKey: 'finish-key-001' }))
    expect('error' in first).toBe(false)
    const second = await h.controller.finish(finishArgs(loopId, { result: 'clean', idempotencyKey: 'finish-key-002' }))
    expect('error' in second).toBe(false)
    expect(second).toEqual(first) // Canonical result, not a second summary.
    expect(h.persistSummary).toHaveBeenCalledTimes(1)
  })

  it('rejects inconsistent post-finish results without persistence', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await h.controller.finish(finishArgs(loopId, { result: 'clean' }))
    const bad = await h.controller.finish(finishArgs(loopId, { result: 'failed', idempotencyKey: 'finish-key-002' }))
    expect(bad).toEqual({ error: 'inconsistent-result' })
    expect(h.persistSummary).toHaveBeenCalledTimes(1)
  })

  it('returns null info only after terminal slots release', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    expect(h.controller.info()?.loopId).toBe(loopId)
    h.controller.cancel('cancelled')
    expect(h.controller.info()).toBeNull()
    // Executing cancellation remains visible until teardown finishes.
    const h2 = makeController()
    const l2 = (await startOk(h2)).loopId
    await h2.controller.submit({ loopId: l2, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    h2.controller.cancel('cancelled')
    expect(h2.controller.info()?.status).toBe('cancelling')
    h2.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    await vi.waitFor(() => expect(h2.controller.info()).toBeNull())
    // Formal finish also removes active info.
    const h3 = makeController()
    const l3 = (await startOk(h3)).loopId
    await h3.controller.finish(finishArgs(l3, { result: 'clean' }))
    expect(h3.controller.info()).toBeNull()
  })

  it('distinguishes next-iteration pointers from executed-round counts', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    // During execution, iteration identifies the current round.
    expect(h.controller.info()?.iteration).toBe(1)
    h.turns[0].settle({ status: 'success', assistantMessageId: 'a1' })
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('reviewing'))
    // After execution, iteration advances while roundsExecuted counts completed runs.
    const st = h.controller.getState()
    expect(st?.iteration).toBe(2)
    expect(st?.roundsExecuted).toBe(1)
  })

  it('evicts history deterministically while retaining recent loops', async () => {
    const h = makeController()
    const ids: string[] = []
    for (let i = 1; i <= 9; i++) {
      const s = await h.controller.start(startArgs({ idempotencyKey: `s${i}` }))
      const id = (s as { loopId: string }).loopId
      ids.push(id)
      h.controller.cancel('cancelled') // reviewing → terminal imediato
    }
    expect(h.controller.getLoop(ids[0])).toBeNull() // The oldest loop left history.
    expect(h.controller.getLoop(ids[1])).not.toBeNull()
    expect(h.controller.getLoop(ids[8])).not.toBeNull()
    // Free slot: a new start succeeds.
    const next = await h.controller.start(startArgs({ idempotencyKey: 's10' }))
    expect('error' in next).toBe(false)
  })

  it('preserves start, submit and finish idempotency across loops', async () => {
    const h = makeController()
    const l1 = (await startOk(h)).loopId
    // Idempotent start returns the SAME loop.
    const retryStart = await h.controller.start(startArgs())
    expect(retryStart).toMatchObject({ loopId: l1 })
    // Idempotent submit within loop 1.
    const sub = await h.controller.submit({ loopId: l1, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    const retrySub = await h.controller.submit({
      loopId: l1,
      iteration: 1,
      findings: [finding('f1')],
      idempotencyKey: 'k1',
    })
    expect(retrySub).toEqual(sub)
    h.turns[0].settle({ status: 'success', assistantMessageId: 'a1' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob).toBeUndefined())
    h.controller.cancel('cancelled')
    // Idempotent finish in terminal loop 1.
    const f1 = await h.controller.finish(finishArgs(l1, { result: 'cancelled', idempotencyKey: 'f1' }))
    expect('error' in f1).toBe(false)
    const f1Retry = await h.controller.finish(finishArgs(l1, { result: 'cancelled', idempotencyKey: 'f1' }))
    expect(f1Retry).toEqual(f1)
    // Another loop may reuse submission keys because caches are loop-scoped.
    const l2 = ((await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))) as { loopId: string }).loopId
    const sub2 = await h.controller.submit({
      loopId: l2,
      iteration: 1,
      findings: [finding('f1')],
      idempotencyKey: 'k1',
    })
    expect('error' in sub2).toBe(false)
    // Different content under the same key within one loop conflicts.
    const conflict = await h.controller.submit({
      loopId: l2,
      iteration: 1,
      findings: [finding('f2')],
      idempotencyKey: 'k1',
    })
    expect(conflict).toEqual({ error: 'idempotency-conflict' })
  })

  it('cleans jobs and locks when disposed during cancellation', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    await h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    h.controller.cancel('cancelled') // cancelling
    h.controller.dispose() // Session termination.
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.controller.info()).toBeNull()
    expect(h.controller.getState()).toBeNull()
    expect(h.controller.getLoop(loopId)).toBeNull()
    // Late runner outcomes resurrect nothing.
    h.turns[0].settle({ status: 'cancelled', assistantMessageId: null })
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.controller.getLoop(loopId)).toBeNull()
    // New controller sessions accept new starts.
    const s = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    expect('error' in s).toBe(false)
  })

  it('does not reuse evidence across loops', async () => {
    // Model bridge loop-ID evidence buckets through the controller contract.
    const buckets = new Map<string, BridgeReviewEvidence>()
    const active = { loopId: null as string | null, iteration: null as number | null }
    const h = makeController({
      getBridgeEvidence: (loopId) => buckets.get(loopId) ?? { contextLoaded: true, byIteration: {}, checks: [] },
      setReviewIteration: (loopId, iteration) => {
        active.loopId = loopId
        active.iteration = iteration
        if (loopId && !buckets.has(loopId)) {
          buckets.set(loopId, { contextLoaded: true, byIteration: {}, checks: [] })
        }
      },
      clearReviewIteration: (loopId) => {
        if (active.loopId === loopId) {
          active.loopId = null
          active.iteration = null
        }
      },
      forgetReviewLoop: (loopId) => {
        buckets.delete(loopId)
        if (active.loopId === loopId) {
          active.loopId = null
          active.iteration = null
        }
      },
    })
    // Loop A investigates and finishes.
    const a = (await startOk(h)).loopId
    buckets.set(a, evidence(1))
    await h.controller.finish(finishArgs(a, { result: 'clean', idempotencyKey: 'fa' }))
    expect(active.loopId).toBeNull() // Clearing A leaves no pointer.
    // Loop B starts without investigation and must be rejected.
    const bStart = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    const b = (bStart as { loopId: string }).loopId
    expect(active.loopId).toBe(b)
    expect(active.iteration).toBe(1)
    expect(
      await h.controller.submit({ loopId: b, iteration: 1, findings: [finding('f1')], idempotencyKey: 'kb' })
    ).toEqual({ error: 'insufficient-investigation' })
    // After fresh B investigation, submission succeeds.
    buckets.set(b, evidence(1))
    expect(
      'error' in
        (await h.controller.submit({ loopId: b, iteration: 1, findings: [finding('f1')], idempotencyKey: 'kb2' }))
    ).toBe(false)
  })

  it('does not clear newer-loop evidence on late old-loop finish', async () => {
    const clears: string[] = []
    const evidenceCalls: string[] = []
    const h = makeController({
      clearReviewIteration: (loopId) => clears.push(loopId),
      getBridgeEvidence: (loopId) => {
        evidenceCalls.push(loopId)
        // A has evidence while B does not.
        return loopId.startsWith('rl_') && evidenceCalls.filter((id) => id === loopId).length <= 2
          ? evidence(1)
          : { contextLoaded: true, byIteration: {}, checks: [] }
      },
    })
    const a = (await startOk(h)).loopId
    // A ends on its own due to failure, before formal finish.
    await h.controller.submit({ loopId: a, iteration: 1, findings: [finding('f1')], idempotencyKey: 'ka' })
    h.turns[0].settle({ status: 'error', error: 'provider failed', assistantMessageId: null })
    await vi.waitFor(() => expect(h.controller.getState()?.finishReason).toBe('failed'))
    // B ativo
    h.getBridgeEvidence.mockImplementation((loopId: string) => {
      evidenceCalls.push(loopId)
      return evidence(1)
    })
    const b = ((await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))) as { loopId: string }).loopId
    expect(h.setReviewIteration).toHaveBeenCalledWith(b, 1)
    clears.length = 0
    // Late finish for A.
    await h.controller.finish(finishArgs(a, { result: 'failed', summary: 'A failed', idempotencyKey: 'fa' }))
    // Clear only A.
    expect(clears).toEqual([a])
    // Read only A evidence.
    expect(evidenceCalls.filter((id) => id === a).length).toBeGreaterThan(0)
    // B remains active and intact.
    expect(h.controller.activeLoopId()).toBe(b)
    expect(h.controller.getState()?.loopId).toBe(b)
  })

  it('retries failed summary persistence once and rejects incompatible results', async () => {
    let failOnce = true
    const persistSummary = vi.fn(async ({ loopId }: { loopId: string; markdown: string }) => {
      if (failOnce) {
        failOnce = false
        return { ok: false as const, error: 'disk-full' }
      }
      return { ok: true as const, messageId: `review-loop-summary:${loopId}` }
    })
    const h = makeController({ persistSummary })
    const loopId = (await startOk(h)).loopId
    // Persistence failure preserves canonical completion and returns a stable error.
    expect(await h.controller.finish(finishArgs(loopId, { result: 'clean', idempotencyKey: 'f1' }))).toEqual({
      error: 'summary-persist-failed',
    })
    expect(h.controller.getLoop(loopId)?.finalization?.summaryPersisted).toBe(false)
    expect(h.controller.getLoop(loopId)?.finalization?.summaryMarkdown).toContain('Review summary')
    // Second attempt with another key and the same result: retries and persists.
    const ok = await h.controller.finish(finishArgs(loopId, { result: 'clean', idempotencyKey: 'f2' }))
    expect('error' in ok).toBe(false)
    expect(h.controller.getLoop(loopId)?.finalization?.summaryPersisted).toBe(true)
    expect(persistSummary).toHaveBeenCalledTimes(2)
    // Already-persisted retries return canonical results without writes.
    const again = await h.controller.finish(finishArgs(loopId, { result: 'clean', idempotencyKey: 'f3' }))
    expect(again).toEqual(ok)
    expect(persistSummary).toHaveBeenCalledTimes(2)
    // Incompatible results remain rejected.
    expect(await h.controller.finish(finishArgs(loopId, { result: 'failed', idempotencyKey: 'f4' }))).toEqual({
      error: 'inconsistent-result',
    })
  })

  it('isolates old-loop persistence retries from active loops', async () => {
    let failA = true
    const h = makeController({
      persistSummary: vi.fn(async ({ loopId }: { loopId: string; markdown: string }) => {
        if (
          loopId.startsWith('rl_') &&
          failA &&
          h.controller.getLoop(loopId)?.roundsExecuted === 0 &&
          !h.controller.getLoop(loopId)?.finalization?.summaryPersisted
        ) {
          // Fail only the first persistence attempt for the first loop.
          if (failA) {
            failA = false
            return { ok: false as const, error: 'transient' }
          }
        }
        return { ok: true as const, messageId: `review-loop-summary:${loopId}` }
      }),
    })
    const a = (await startOk(h)).loopId
    expect(await h.controller.finish(finishArgs(a, { result: 'clean', idempotencyKey: 'fa1' }))).toEqual({
      error: 'summary-persist-failed',
    })
    // B starts.
    const b = ((await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))) as { loopId: string }).loopId
    expect(h.controller.activeLoopId()).toBe(b)
    // Retry unpersisted A.
    const retry = await h.controller.finish(finishArgs(a, { result: 'clean', idempotencyKey: 'fa2' }))
    expect('error' in retry).toBe(false)
    // Preserve B locks, status and evidence pointers.
    expect(h.controller.activeLoopId()).toBe(b)
    expect(h.controller.getState()?.loopId).toBe(b)
    expect(h.controller.getState()?.status).toBe('reviewing')
    // Clearing A evidence does not change active B.
    expect(h.clearReviewIteration).toHaveBeenCalledWith(a)
  })
})

describe('isReviewLoopConversationReserved', () => {
  it('reserves cancelling and terminal-teardown intervals', async () => {
    const { isReviewLoopConversationReserved } = await import('../../src/shared/chat')
    expect(isReviewLoopConversationReserved('reviewing')).toBe(true)
    expect(isReviewLoopConversationReserved('executing')).toBe(true)
    expect(isReviewLoopConversationReserved('finishing')).toBe(true)
    expect(isReviewLoopConversationReserved('cancelling')).toBe(true)
    expect(isReviewLoopConversationReserved('finished')).toBe(true)
    expect(isReviewLoopConversationReserved('cancelled')).toBe(true)
    expect(isReviewLoopConversationReserved('interrupted')).toBe(false)
    expect(isReviewLoopConversationReserved(null)).toBe(false)
    expect(isReviewLoopConversationReserved(undefined)).toBe(false)
  })
})

describe('stable evidence ownership end-to-end gates', () => {
  it('does not credit late old-iteration tools to new submissions', async () => {
    // Credit evidence to admission owners instead of current pointers.
    // buckets[loopId][iteration] = counts; late credit from an iteration 1 tool does NOT fill iteration 2.
    const buckets = new Map<string, Map<number, { diff: number; search: number; read: number }>>()
    const active = { loopId: null as string | null, iteration: null as number | null }
    // Capture in-flight ownership in iteration one.
    let inFlightOwner: { loopId: string; iteration: number } | null = null

    const h = makeController({
      getBridgeEvidence: (loopId) => {
        const byIt = buckets.get(loopId)
        return {
          contextLoaded: true,
          byIteration: byIt ? Object.fromEntries(byIt) : {},
          checks: [],
        }
      },
      setReviewIteration: (loopId, iteration) => {
        active.loopId = loopId
        active.iteration = iteration
        if (loopId && !buckets.has(loopId)) buckets.set(loopId, new Map())
      },
      clearReviewIteration: (loopId) => {
        if (active.loopId === loopId) {
          active.loopId = null
          active.iteration = null
        }
      },
      forgetReviewLoop: (loopId) => {
        buckets.delete(loopId)
        if (active.loopId === loopId) {
          active.loopId = null
          active.iteration = null
        }
      },
    })

    const loopId = (await startOk(h)).loopId
    // Fresh investigation for iteration one admission.
    buckets.get(loopId)!.set(1, { diff: 1, search: 1, read: 1 })
    // Capture uncredited in-flight tool ownership.
    inFlightOwner = { loopId, iteration: 1 }

    // Execute round one and advance to iteration two.
    await runRound(h, loopId, 1, 'k1', () => h.setGit('diff --no-ext-diff --no-textconv', 'change 1'))
    expect(h.controller.getState()?.iteration).toBe(2)
    expect(active.iteration).toBe(2)

    // Late tools credit captured iteration one, never iteration two.
    const byIt = buckets.get(inFlightOwner.loopId)!
    const entry = byIt.get(inFlightOwner.iteration) ?? { diff: 0, search: 0, read: 0 }
    entry.read += 1 // Late credit for iteration 1.
    byIt.set(inFlightOwner.iteration, entry)

    // Iteration two without its own investigation remains rejected.
    // Late iteration-one evidence cannot satisfy iteration-two gates.
    expect(
      await h.controller.submit({
        loopId,
        iteration: 2,
        findings: [finding('f2')],
        idempotencyKey: 'k2',
      })
    ).toEqual({ error: 'insufficient-investigation' })

    // Fresh iteration-two investigation allows submission.
    buckets.get(loopId)!.set(2, { diff: 1, search: 1, read: 1 })
    expect(
      'error' in
        (await h.controller.submit({
          loopId,
          iteration: 2,
          findings: [finding('f2')],
          idempotencyKey: 'k2b',
        }))
    ).toBe(false)
  })
})

describe('fingerprint and validation helpers', () => {
  it('fingerprints branch, head and workspace changes', () => {
    const base: WorkspaceSnapshot = { branch: 'main', head: 'h1', unstaged: 'a', staged: '', untracked: [] }
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }))
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, branch: 'dev' }))
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, head: 'h2' }))
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, unstaged: 'b' }))
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, untracked: [{ path: 'new.ts', hash: 'x' }] }))
  })

  it('validates finding severity, size and paths', () => {
    expect(validateFindingsShape([])).toMatchObject({ ok: false })
    expect(validateFindingsShape([finding('x')])).toMatchObject({ ok: true })
    expect(validateFindingsShape([finding('x', 'important')])).toMatchObject({ ok: true })
    expect(validateFindingsShape([finding('x', 'optional')])).toMatchObject({ ok: true })
    expect(validateFindingsShape([{ ...finding('x'), paths: ['../escape.ts'] }])).toMatchObject({ ok: false })
    expect(validateFindingsShape([{ ...finding('x'), paths: ['/abs.ts'] }])).toMatchObject({ ok: false })
    expect(validateFindingsShape([{ ...finding('x'), paths: ['src/ok.ts'] }])).toMatchObject({ ok: true })
    expect(validateFindingsShape([{ id: 'x', severity: 'optional', title: 't' }])).toMatchObject({ ok: false })

    const tooMany = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => finding(`f${i}`))
    expect(validateFindingsShape(tooMany)).toEqual({
      ok: false,
      error: `Maximum of ${MAX_FINDINGS} findings per round.`,
    })

    // Individually bounded details can still overflow the total 80k limit.
    const chunk = 'x'.repeat(4000)
    const manyLarge = Array.from({ length: 21 }, (_, i) => ({
      ...finding(`big${i}`),
      details: chunk,
    }))
    expect(validateFindingsShape(manyLarge)).toEqual({
      ok: false,
      error: `Findings too large (limit of ${MAX_FINDINGS_TOTAL_CHARS} characters).`,
    })
  })

  it('rejects findings overflow before executor start', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    const tooMany = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => finding(`f${i}`))
    const blocked = await h.controller.submit({
      loopId,
      iteration: 1,
      findings: tooMany,
      idempotencyKey: 'overflow',
    })
    expect(blocked).toEqual({ error: `Maximum of ${MAX_FINDINGS} findings per round.` })
    expect(h.startTurn).not.toHaveBeenCalled()
    expect(h.controller.getState()?.status).toBe('reviewing')
  })

  it('returns canonical terminal state on the first pending wait', async () => {
    const h = makeController()
    const loopId = (await startOk(h)).loopId
    // Round 1 makes real workspace progress; round 2 wait must see madeProgress=true.
    await runRound(h, loopId, 1, 'k1', () => h.setGit('diff --no-ext-diff --no-textconv', 'change A'))
    expect(h.controller.getState()?.iteration).toBe(2)

    // Start wait during pending round two to reproduce terminal-state races.
    // finalizeJob marks the job terminal BEFORE the controller updates iteration/status.
    h.getBridgeEvidence.mockReturnValue(evidence(2))
    const sub = await h.controller.submit({ loopId, iteration: 2, findings: [finding('f2')], idempotencyKey: 'k2' })
    const jobId = (sub as { jobId: string }).jobId
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    expect(h.controller.getState()?.status).toBe('executing')
    h.setGit('diff --no-ext-diff --no-textconv', 'change B')
    h.turns[h.turns.length - 1].settle({ status: 'success', assistantMessageId: 'assistant-2' })

    // The first terminal response already contains canonical controller state.
    const first = await waiting
    expect(first).toMatchObject({
      status: 'completed',
      madeProgress: true,
      nextIteration: 3,
      canContinue: true,
    })
    expect(first).not.toHaveProperty('stopReason') // canContinue=true: no spurious stopReason.
    expect(h.controller.getState()?.iteration).toBe(3)
    expect(h.controller.getState()?.status).toBe('reviewing')
  })

  it('releases slots and resolves waits after selection validation rejection', async () => {
    let rejectRevalidate!: (error: Error) => void
    const revalidateSelection = vi.fn(
      () =>
        new Promise<{ ok: true } | { ok: false; error: string }>((_resolve, reject) => {
          rejectRevalidate = reject
        })
    )
    const h = makeController({ revalidateSelection })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    // Jobs remain active while hooks are pending, then settle on rejection.
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob?.jobId).toBeTruthy())
    const jobId = h.controller.getState()?.activeJob?.jobId as string
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    rejectRevalidate(new Error('broken-ipc'))
    expect(await subPromise).toEqual({ error: 'review-loop-failed' })
    // Wait resolves TERMINAL, never polling for 30 seconds or returning running.
    expect(await waiting).toMatchObject({
      status: 'failed',
      iteration: 1,
      canContinue: false,
      stopReason: 'failed',
      executorSummary: 'broken-ipc',
    })
    // Ended loops release slots immediately; Stop on empty slots is harmless.
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.controller.getState()?.status).toBe('finished')
    expect(h.controller.getState()?.finishReason).toBe('failed')
    h.controller.cancel('cancelled') // Does not hang or reopen state.
    const again = await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))
    expect('error' in again).toBe(false)
    expect((again as { loopId: string }).loopId).not.toBe(loopId)
  })

  it('classifies rejected starts and releases terminal job slots', async () => {
    let rejectTurn!: (error: Error) => void
    const startTurn = vi.fn(
      () =>
        new Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }>((_resolve, reject) => {
          rejectTurn = reject
        })
    )
    const h = makeController({ startTurn })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob?.jobId).toBeTruthy())
    const jobId = h.controller.getState()?.activeJob?.jobId as string
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    rejectTurn(new Error('no-key'))
    // Preserve executor-unavailable classification instead of generic failure.
    expect(await subPromise).toEqual({ error: 'executor-unavailable' })
    expect(await waiting).toMatchObject({
      status: 'failed',
      canContinue: false,
      stopReason: 'executor_unavailable',
    })
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.controller.getState()?.finishReason).toBe('executor_unavailable')
    // Verify released slots admit new jobs and contain hook rejection.
    const again = ((await h.controller.start(startArgs({ idempotencyKey: 'start-key-002' }))) as { loopId: string })
      .loopId
    expect(again).not.toBe(loopId)
    const sub2 = h.controller.submit({ loopId: again, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k2' })
    await vi.waitFor(() => expect(h.controller.getState()?.status).toBe('executing'))
    expect(h.controller.getState()?.loopId).toBe(again)
    rejectTurn(new Error('no-model'))
    expect(await sub2).toEqual({ error: 'executor-unavailable' })
    expect(h.controller.activeLoopId()).toBeNull()
  })

  it('settles failed revalidation and releases unavailable executors', async () => {
    let resolveRevalidate!: (r: { ok: true } | { ok: false; error: string }) => void
    const revalidateSelection = vi.fn(
      () =>
        new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
          resolveRevalidate = resolve
        })
    )
    const h = makeController({ revalidateSelection })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    // Concurrent callers capture job IDs before pending hooks resolve.
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob?.jobId).toBeTruthy())
    const jobId = h.controller.getState()?.activeJob?.jobId as string
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    resolveRevalidate({ ok: false, error: 'no-key' })
    expect(await subPromise).toEqual({ error: 'executor-unavailable' })
    // Wait resolves terminal classification without lingering running state.
    expect(await waiting).toMatchObject({
      status: 'failed',
      iteration: 1,
      canContinue: false,
      stopReason: 'executor_unavailable',
      executorSummary: 'no-key',
    })
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.controller.getState()?.status).toBe('finished')
    expect(h.controller.getState()?.finishReason).toBe('executor_unavailable')
  })

  it('returns transient failed starts to reviewing after terminal job exposure', async () => {
    let resolveTurn!: (r: { ok: true; handle: InternalTurnHandle } | { ok: false; error: string }) => void
    const startTurn = vi.fn(
      () =>
        new Promise<{ ok: true; handle: InternalTurnHandle } | { ok: false; error: string }>((resolve) => {
          resolveTurn = resolve
        })
    )
    const h = makeController({ startTurn })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob?.jobId).toBeTruthy())
    const jobId = h.controller.getState()?.activeJob?.jobId as string
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    resolveTurn({ ok: false, error: 'busy' })
    expect(await subPromise).toEqual({ error: 'busy' })
    // Wait resolves failed terminals without waiting for the deadline.
    expect(await waiting).toMatchObject({
      status: 'failed',
      iteration: 1,
      canContinue: true,
      executorSummary: 'busy',
    })
    // Transient errors leave loops reviewing and eligible for retry;
    expect(h.controller.activeLoopId()).toBe(loopId)
    expect(h.controller.getState()?.status).toBe('reviewing')
    // late waits still retrieve terminal jobs.
    const late = await h.controller.wait({ loopId, jobId, waitSeconds: 5 })
    expect(late).toMatchObject({ status: 'failed', iteration: 1 })
  })

  it('never revives stopped loops during revalidation', async () => {
    let resolveRevalidate!: (r: { ok: true } | { ok: false; error: string }) => void
    const revalidateSelection = vi.fn(
      () =>
        new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
          resolveRevalidate = resolve
        })
    )
    const h = makeController({ revalidateSelection })
    const loopId = (await startOk(h)).loopId
    const subPromise = h.controller.submit({ loopId, iteration: 1, findings: [finding('f1')], idempotencyKey: 'k1' })
    await vi.waitFor(() => expect(h.controller.getState()?.activeJob?.jobId).toBeTruthy())
    const jobId = h.controller.getState()?.activeJob?.jobId as string
    const waiting = h.controller.wait({ loopId, jobId, waitSeconds: 30 })
    h.controller.cancel('cancelled') // Stop while revalidation hangs: status becomes cancelling and aborts.
    resolveRevalidate({ ok: false, error: 'no-key' })
    expect(await subPromise).toEqual({ error: 'review-loop-cancelled' })
    expect(await waiting).toMatchObject({
      status: 'cancelled',
      iteration: 1,
      canContinue: false,
      stopReason: 'cancelled',
    })
    // The ok:false branch CANNOT reverse cancellation: the loop remains terminal and the slot stays free.
    expect(h.controller.activeLoopId()).toBeNull()
    expect(h.controller.getState()?.status).toBe('cancelled')
    expect(h.controller.getState()?.finishReason).toBe('cancelled')
  })
})
