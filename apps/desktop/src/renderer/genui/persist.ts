import type { GenUiState } from './runtime'

// What the person changed in each generated interface, so a reload or reopening the conversation shows it as they
// left it. Kept in this renderer's localStorage, keyed by message and program: it does not follow the conversation to
// other computers.

const STORAGE_KEY = 'genui.state.v1'
const MAX_ENTRIES = 200
const MAX_STATE_CHARS = 20_000
const WRITE_DELAY_MS = 250

type Entries = Record<string, { at: number; state: GenUiState }>

function readEntries(storage: Storage): Entries {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Entries) : {}
  } catch {
    return {}
  }
}

/** FNV-1a: tells programs of one message apart without storing them. */
export function programHash(code: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function loadGenUiState(key: string, storage: Storage = localStorage): GenUiState | undefined {
  const entries = readEntries(storage)
  const state = Object.hasOwn(entries, key) ? entries[key]?.state : undefined
  return state && typeof state === 'object' && !Array.isArray(state) ? state : undefined
}

function writeState(key: string, state: GenUiState, storage: Storage): void {
  const entries = readEntries(storage)
  let serialized: string
  try {
    serialized = JSON.stringify(state)
  } catch {
    return
  }
  if (Object.keys(state).length === 0 || serialized.length > MAX_STATE_CHARS) delete entries[key]
  else entries[key] = { at: Date.now(), state: JSON.parse(serialized) as GenUiState }
  const kept = Object.entries(entries)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_ENTRIES)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // A full storage only costs the restore
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** Saves after the input settles: a slider reports every step it passes. */
export function saveGenUiState(key: string, state: GenUiState, storage: Storage = localStorage): void {
  clearTimeout(pending.get(key))
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      writeState(key, state, storage)
    }, WRITE_DELAY_MS)
  )
}
