import { isDeepStrictEqual } from 'node:util'
import type { ToolOutput } from '../../../shared/chat'
import { modelOutputToChatToolOutput, toolOutputIsError } from '../tool-output'
import { redactClaudeCredentials } from './errors'

export interface ClaudeToolJournalEntry {
  attemptId: string
  toolCallId: string
  toolName: string
  input: unknown
  state: 'running' | 'completed' | 'failed' | 'uncertain'
  output?: ToolOutput
  error?: string
}

export interface ClaudeToolJournal {
  run<T>(toolCallId: string, toolName: string, input: unknown, execute: () => Promise<T>): Promise<T>
  /** Tracks projection/transport callbacks after their host result is already durable. */
  track<T>(operation: () => Promise<T>): Promise<T>
  snapshot(): readonly ClaudeToolJournalEntry[]
  stopAccepting(): void
  drain(signal: AbortSignal): Promise<void>
}

function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return
    Object.freeze(item)
    for (const child of Object.values(item)) freeze(child)
  }
  freeze(copy)
  return copy
}

export function createClaudeToolJournal({
  attemptId,
  onEntry,
}: {
  attemptId: string
  onEntry?: (entry: ClaudeToolJournalEntry) => void
}): ClaudeToolJournal {
  const calls = new Map<string, { entry: ClaudeToolJournalEntry; promise: Promise<unknown> }>()
  const callbacks = new Set<Promise<unknown>>()
  let accepting = true
  const publish = (entry: ClaudeToolJournalEntry) => onEntry?.(immutable(entry))
  return {
    run<T>(toolCallId: string, toolName: string, input: unknown, execute: () => Promise<T>): Promise<T> {
      const prior = calls.get(toolCallId)
      if (prior) {
        if (prior.entry.toolName !== toolName || !isDeepStrictEqual(prior.entry.input, input))
          return Promise.reject(new Error(`Conflicting Claude tool call: ${toolCallId}`))
        return prior.promise as Promise<T>
      }
      if (!accepting) return Promise.reject(new Error('Claude tool journal is no longer accepting calls.'))
      const entry: ClaudeToolJournalEntry = {
        attemptId,
        toolCallId,
        toolName,
        input: structuredClone(input),
        state: 'running',
      }
      // Defer execution so retries (including reentrant observers) see the same promise.
      const promise = Promise.resolve().then(async () => {
        try {
          publish(entry)
        } catch (error) {
          entry.state = 'failed'
          entry.error = redactClaudeCredentials(String(error))
          throw error
        }
        let output: T
        try {
          output = await execute()
          entry.output = immutable(modelOutputToChatToolOutput(output))
          entry.state = toolOutputIsError(entry.output) ? 'failed' : 'completed'
        } catch (error) {
          // A thrown host error cannot prove that an external effect did not occur.
          entry.state = 'uncertain'
          entry.error = redactClaudeCredentials(String(error))
          try {
            publish(entry)
          } catch {
            /* Preserve the execution error and retained entry. */
          }
          throw error
        }
        publish(entry)
        return output
      })
      calls.set(toolCallId, { entry, promise })
      // The owner may drain after a disconnected SDK has abandoned its callback.
      void promise.catch(() => {})
      return promise
    },
    track<T>(operation: () => Promise<T>): Promise<T> {
      if (!accepting) return Promise.reject(new Error('Claude tool journal is no longer accepting calls.'))
      const promise = Promise.resolve().then(operation)
      callbacks.add(promise)
      void promise.then(
        () => callbacks.delete(promise),
        () => callbacks.delete(promise)
      )
      return promise
    },
    snapshot: () => immutable([...calls.values()].map(({ entry }) => entry)),
    stopAccepting: () => {
      accepting = false
    },
    async drain(signal) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('Claude tool drain aborted.'))
        signal.addEventListener('abort', onAbort, { once: true })
        void Promise.allSettled([...callbacks, ...[...calls.values()].map(({ promise }) => promise)]).then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    },
  }
}
