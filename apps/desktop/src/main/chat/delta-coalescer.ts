/**
 * Streaming coalescer (#559, review gap #3): batches ONLY `text-delta`/`reasoning-delta`,
 * concatenating deltas for the SAME `partId`, emitting at most every `intervalMs` (~40 ms). Reduces
 * IPC and last-bubble rerender frequency WITHOUT changing event shape or folding — a
 * concatenated `text-delta` is a valid event the renderer folds identically.
 *
 * NARROW contract (preserves text→tool→result order):
 *  - Every NON-delta event DRAINS pending buffers in part-appearance order
 *    BEFORE emission — `tool-call`, `finish`, `aborted`, `error`, `*-start` never arrive
 *    before their preceding text;
 *  - End-of-turn `flush()`/`dispose()` ensures the last delta is not stranded and the timer
 *    does not leak in a background turn without a renderer.
 *
 * Only EMISSION is coalesced: main's persistence `applyChatEvent` still processes every event (high-fidelity
 * SQLite state). The coalescer therefore intercepts only renderer output.
 */
import type { ChatStreamEvent } from '../../shared/chat'

type DeltaKind = 'text-delta' | 'reasoning-delta'

interface BufferedDelta {
  kind: DeltaKind
  messageId: string
  partId: string
  delta: string
}

export interface DeltaCoalescer {
  /** Forwards an event: buffer deltas; anything else drains and emits immediately. */
  push(ev: ChatStreamEvent): void
  /** Drains pending buffers (emits concatenated deltas). Idempotent. */
  flush(): void
  /** Cancels the pending timer (emits nothing). Call after flush at turn end. */
  dispose(): void
}

function isDelta(ev: ChatStreamEvent): ev is Extract<ChatStreamEvent, { kind: DeltaKind }> {
  return ev.kind === 'text-delta' || ev.kind === 'reasoning-delta'
}

/**
 * Creates a coalescer around `emit`. Injectable `schedule` supports tests (default = setTimeout); it must return
 * a function that CANCELS the scheduled call.
 */
export function createDeltaCoalescer(
  emit: (ev: ChatStreamEvent) => void,
  opts: { intervalMs?: number; schedule?: (fn: () => void, ms: number) => () => void } = {},
): DeltaCoalescer {
  const intervalMs = opts.intervalMs ?? 40
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })

  // Map<partId> → accumulated delta. Map insertion order preserves part-appearance order.
  const buffers = new Map<string, BufferedDelta>()
  let cancelTimer: (() => void) | null = null

  const clearTimer = (): void => {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
  }

  const flush = (): void => {
    clearTimer()
    if (buffers.size === 0) return
    const pending = [...buffers.values()]
    buffers.clear()
    for (const b of pending) {
      emit({ kind: b.kind, messageId: b.messageId, partId: b.partId, delta: b.delta })
    }
  }

  const push = (ev: ChatStreamEvent): void => {
    if (isDelta(ev)) {
      const existing = buffers.get(ev.partId)
      if (existing && existing.kind === ev.kind && existing.messageId === ev.messageId) {
        existing.delta += ev.delta
      } else {
        // New partId (or unlikely kind/message change for the same ID): drain earlier parts to avoid
        // reordering, then start a new buffer. Delete ensures correct insertion order.
        if (existing) flush()
        buffers.set(ev.partId, { kind: ev.kind, messageId: ev.messageId, partId: ev.partId, delta: ev.delta })
      }
      if (!cancelTimer) cancelTimer = schedule(flush, intervalMs)
      return
    }
    // Non-delta event: drain everything pending BEFORE it (preserving order) and emit immediately.
    flush()
    emit(ev)
  }

  const dispose = (): void => {
    clearTimer()
    buffers.clear()
  }

  return { push, flush, dispose }
}
