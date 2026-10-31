import { runHistoryIndexStep } from './store'

/**
 * Background upkeep of the history index on the main process: short slices with pauses between them, so the
 * backfill of a large profile never blocks the UI, and a slow poll once everything is covered. Searches bring their
 * own conversations up to date first, so this pass only keeps the rest warm.
 */
export const HISTORY_INDEXER = {
  startDelayMs: 20_000,
  sliceMs: 8,
  busyPauseMs: 25,
  idlePollMs: 4_000,
} as const

let timer: ReturnType<typeof setTimeout> | null = null
let running = false

function schedule(delayMs: number): void {
  timer = setTimeout(tick, delayMs)
  timer.unref?.()
}

function tick(): void {
  timer = null
  if (!running) return
  let busy = false
  try {
    busy = runHistoryIndexStep(HISTORY_INDEXER.sliceMs)
  } catch (error) {
    console.warn('[history-index] background pass failed:', error instanceof Error ? error.message : error)
  }
  if (running) schedule(busy ? HISTORY_INDEXER.busyPauseMs : HISTORY_INDEXER.idlePollMs)
}

export function startHistoryIndexer(startDelayMs: number = HISTORY_INDEXER.startDelayMs): void {
  if (running) return
  running = true
  schedule(startDelayMs)
}

export function stopHistoryIndexer(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
}
