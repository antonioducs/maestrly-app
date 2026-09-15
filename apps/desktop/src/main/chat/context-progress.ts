import { randomUUID } from 'node:crypto'
import type { ChatCompactionProgress, ChatContextSnapshot, ChatModelRef, ChatStreamEvent } from '../../shared/chat'
import type { PortableSummaryCallResult, PortableSummaryProgress } from './portable-context'

export type ContextSample = Pick<ChatContextSnapshot, 'usedTokens' | 'modelContextWindow' | 'quality'>

/** One assistant owns this publisher across runtime attempts; billing usage never passes through it. */
export function createContextProgressPublisher(args: {
  messageId: string
  model: ChatModelRef
  apply: (event: ChatStreamEvent, force: boolean) => void
  sanitizeError: (error: unknown) => string
  onCompactionError: (error: string, cancelled: boolean) => void
}) {
  let sequence = 0
  let generation = 0
  let disposed = false
  let lastPublishedAt: number | undefined
  let pending: ChatContextSnapshot | undefined
  let latest: ChatContextSnapshot | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let progress: ChatCompactionProgress | undefined
  let awaitingReduction = false

  const publishProgress = (next: ChatCompactionProgress): void => {
    if (disposed) return
    progress = next
    args.apply({ kind: 'compaction-progress', messageId: args.messageId, progress: next }, true)
  }
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (disposed || !pending) return
    latest = pending
    pending = undefined
    lastPublishedAt = Date.now()
    args.apply({ kind: 'context-usage', messageId: args.messageId, snapshot: latest }, true)
    if (awaitingReduction && progress?.status === 'completed') {
      publishProgress({
        ...progress,
        afterTokens: latest.usedTokens,
        afterQuality: latest.quality,
        updatedAt: Date.now(),
      })
      awaitingReduction = latest.quality !== 'measured'
    }
  }
  const sample = (value: ContextSample): void => {
    if (disposed || !Number.isFinite(value.usedTokens) || value.usedTokens < 0) return
    const window = value.modelContextWindow
    pending = {
      usedTokens: Math.floor(value.usedTokens),
      ...(window != null && Number.isFinite(window) && window > 0 ? { modelContextWindow: Math.floor(window) } : {}),
      quality: value.quality,
      model: { ...args.model },
      observedAt: Date.now(),
      sequence: ++sequence,
    }
    const delay = lastPublishedAt == null ? 0 : Math.max(0, 1_000 - (Date.now() - lastPublishedAt))
    if (!delay) flush()
    else if (!timer) {
      timer = setTimeout(flush, delay)
      timer.unref?.()
    }
  }
  const boundary = (): void => {
    flush()
    generation += 1
  }

  return {
    flush,
    boundary,
    /** Captured by an attempt so late async observations cannot replace its successor. */
    observeAttempt(): (value: ContextSample) => void {
      boundary()
      const attempt = generation
      return (value) => {
        if (attempt === generation) sample(value)
      }
    },
    /** Native auto-compaction runs inside the current attempt, so its observer must remain valid. */
    beginNative() {
      flush()
      awaitingReduction = false
      const id = randomUUID()
      publishProgress({
        id,
        status: 'running',
        phase: 'native',
        ...(latest ? { beforeTokens: latest.usedTokens } : {}),
        updatedAt: Date.now(),
      })
      let active = true
      return {
        complete(after?: ContextSample): void {
          if (!active || disposed || progress?.id !== id) return
          active = false
          publishProgress({ ...progress, status: 'completed', updatedAt: Date.now() })
          awaitingReduction = true
          if (after) {
            sample(after)
            flush()
          }
        },
        fail(error: unknown, cancelled: boolean): void {
          if (!active || disposed || progress?.id !== id) return
          active = false
          awaitingReduction = false
          const diagnostic = args.sanitizeError(error)
          publishProgress({
            ...progress,
            status: cancelled ? 'cancelled' : 'failed',
            error: diagnostic,
            updatedAt: Date.now(),
          })
          args.onCompactionError(diagnostic, cancelled)
        },
      }
    },
    async compact<T>(
      work: (onProgress: (value: PortableSummaryProgress) => void) => Promise<T>,
      options: {
        signal: AbortSignal
        phase?: 'native'
        validate?: (result: T) => boolean
        failureMessage: string
        afterSample?: (result: T) => ContextSample | undefined
      }
    ): Promise<T> {
      boundary()
      awaitingReduction = false
      const id = randomUUID()
      publishProgress({
        id,
        status: 'running',
        ...(options.phase ? { phase: options.phase } : {}),
        ...(latest ? { beforeTokens: latest.usedTokens } : {}),
        updatedAt: Date.now(),
      })
      let active = true
      let completedResult: unknown
      try {
        options.signal.throwIfAborted()
        const result = await work((stage) => {
          if (active && progress?.id === id && !options.signal.aborted) {
            publishProgress({ ...progress, ...stage, updatedAt: Date.now() })
          }
        })
        completedResult = result
        options.signal.throwIfAborted()
        if (options.validate && !options.validate(result)) throw new Error(options.failureMessage)
        if (progress?.id === id) {
          publishProgress({ ...progress, status: 'completed', updatedAt: Date.now() })
          awaitingReduction = true
          const after = options.afterSample?.(result)
          if (after) {
            sample(after)
            flush()
          }
        }
        return result
      } catch (error) {
        // Stop can arrive after the helper resolves but before its summary is committed by the runner.
        // Preserve that completed call's bill without mutating the caller's AbortSignal.reason.
        const returned = completedResult as Partial<PortableSummaryCallResult> | null | undefined
        const failure =
          returned && (returned.usage || returned.runtimeEstimatedCostUsd != null)
            ? Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
                partialUsage: returned.usage,
                runtimeEstimatedCostUsd: returned.runtimeEstimatedCostUsd,
              })
            : error
        const diagnostic = args.sanitizeError(failure)
        const cancelled = options.signal.aborted
        if (progress?.id === id) {
          publishProgress({
            ...progress,
            status: cancelled ? 'cancelled' : 'failed',
            ...(cancelled ? {} : { error: diagnostic }),
            updatedAt: Date.now(),
          })
        }
        args.onCompactionError(diagnostic, cancelled)
        throw failure
      } finally {
        active = false
      }
    },
    dispose(): void {
      flush()
      disposed = true
      generation += 1
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
