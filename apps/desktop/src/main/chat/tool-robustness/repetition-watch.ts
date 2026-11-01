/**
 * Detects a model stuck repeating itself in its visible text or its reasoning, so the runner can cut the generation
 * instead of paying for tokens of the same paragraph until the output limit. The checks are adapted from Hermes
 * Agent and OpenClaw (repeated windows, a dominant line, a repeating period); no code is copied.
 *
 * Tables, code and lists, whose lines are mostly distinct, skip the line and window checks. The period check stays:
 * it needs the same exact passage at least five times in a row, covering half of the analyzed text.
 */

export type RepetitionChannel = 'text' | 'reasoning'

export interface RepetitionVerdict {
  channel: RepetitionChannel
  kind: 'window' | 'line' | 'period'
}

export interface RepetitionWatchConfig {
  /** No check before a channel holds this many characters in the turn. */
  minChars: number
  /** Characters added between checks, bounding the cost on long outputs. */
  checkEvery: number
  /** Only the end of the channel is analyzed. */
  tailChars: number
}

export const DEFAULT_REPETITION_WATCH_CONFIG: Readonly<RepetitionWatchConfig> = Object.freeze({
  minChars: 16_000,
  checkEvery: 4_000,
  tailChars: 16_000,
})

const WINDOW = 60
const MIN_WINDOW_REPEATS = 5
const MIN_COVERAGE = 0.5
const MIN_LINES = 10
const MIN_DOMINANT_LINE_LENGTH = 8
const PERIOD_NEEDLE = 120
const MIN_PERIOD_REPEATS = 5

function dominantLine(lines: readonly string[]): boolean {
  const counts = new Map<string, number>()
  let best = 0
  for (const line of lines) {
    if (line.length < MIN_DOMINANT_LINE_LENGTH) continue
    const count = (counts.get(line) ?? 0) + 1
    counts.set(line, count)
    if (count > best) best = count
  }
  return best >= MIN_LINES && best / lines.length >= MIN_COVERAGE
}

function repeatedWindows(text: string): boolean {
  const counts = new Map<string, number>()
  const total = Math.floor(text.length / WINDOW)
  if (total < MIN_WINDOW_REPEATS) return false
  for (let index = 0; index < total; index++) {
    const window = text.slice(index * WINDOW, (index + 1) * WINDOW)
    counts.set(window, (counts.get(window) ?? 0) + 1)
  }
  let covered = 0
  for (const count of counts.values()) if (count >= MIN_WINDOW_REPEATS) covered += count
  return covered / total >= MIN_COVERAGE
}

/** The end of the text repeats with some period at least five times, over at least half of it. */
function repeatingPeriod(text: string): boolean {
  if (text.length < PERIOD_NEEDLE * 2) return false
  const needle = text.slice(-PERIOD_NEEDLE)
  const previous = text.lastIndexOf(needle, text.length - PERIOD_NEEDLE - 1)
  if (previous < 0) return false
  const period = text.length - PERIOD_NEEDLE - previous
  let index = text.length - 1
  while (index - period >= 0 && text.charCodeAt(index) === text.charCodeAt(index - period)) index--
  const matched = text.length - 1 - index + period
  return matched >= period * MIN_PERIOD_REPEATS && matched / text.length >= MIN_COVERAGE
}

/** Most of the characters belong to lines that appear once, weighting each line by its length. */
function mostlyDistinctLines(lines: readonly string[]): boolean {
  if (lines.length < MIN_LINES) return false
  const seen = new Set<string>()
  let total = 0
  let distinct = 0
  for (const line of lines) {
    total += line.length
    if (seen.has(line)) continue
    seen.add(line)
    distinct += line.length
  }
  return distinct / total >= MIN_COVERAGE
}

/** Classifies one piece of output; null when it is not degenerate. */
export function detectRepetition(text: string): RepetitionVerdict['kind'] | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!mostlyDistinctLines(lines)) {
    if (lines.length >= MIN_LINES && dominantLine(lines)) return 'line'
    if (repeatedWindows(text)) return 'window'
  }
  if (repeatingPeriod(text)) return 'period'
  return null
}

export interface RepetitionWatch {
  /** Adds streamed output; returns a verdict once the channel became degenerate. */
  push(channel: RepetitionChannel, delta: string): RepetitionVerdict | null
}

export function createRepetitionWatch(
  config: RepetitionWatchConfig = DEFAULT_REPETITION_WATCH_CONFIG
): RepetitionWatch {
  const channels: Record<RepetitionChannel, { text: string; total: number; nextCheck: number }> = {
    text: { text: '', total: 0, nextCheck: config.minChars },
    reasoning: { text: '', total: 0, nextCheck: config.minChars },
  }
  return {
    push(channel, delta) {
      if (!delta) return null
      const state = channels[channel]
      state.total += delta.length
      state.text += delta
      if (state.text.length > config.tailChars * 2) state.text = state.text.slice(-config.tailChars)
      if (state.total < state.nextCheck) return null
      state.nextCheck = state.total + config.checkEvery
      const kind = detectRepetition(state.text.slice(-config.tailChars))
      return kind ? { channel, kind } : null
    },
  }
}
