import path from 'node:path'
import { safeWindowSend } from './window-ipc'
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import type { BrowserWindow } from 'electron'
import { SELECTION_REL_DIR, SELECTION_FILE } from './vscode/vscode-ext-source'

/**
 * VS Code to Chat bridge. The extension writes <cwd>/.maestrly/agent-selection.json on the real
 * filesystem; serve-web globalStorage uses vscode-userdata: and cannot be watched on disk. Watch each
 * cwd once and send file or line-range references to its conversation composer. Shared worktrees can
 * have multiple sibling conversations (#322); keep a set of conversation IDs per cwd and prefer the
 * visible sibling, falling back to the only sibling or the one that most recently opened VS Code.
 */

interface SelectionPayload {
  kind: 'file' | 'selection'
  path: string
  scheme: string
  startLine?: number
  endLine?: number
  languageId?: string
  ts: number
}

let win: BrowserWindow | null = null
// One watcher per cwd; lastTs deduplicates repeated fs.watch events.
const watchers = new Map<string, FSWatcher>()
const lastTs = new Map<string, number>()
// Sibling conversation IDs share one cwd watcher. Set insertion order determines the most recently opened
// editor for fallback routing and reference counting (#322).
const convByCwd = new Map<string, Set<string>>()
// The visible conversation reported by the renderer takes priority when routing selections among siblings
// sharing a cwd.
let visibleConvId: string | null = null

export function initSelectionBridge(window: BrowserWindow): void {
  win = window
}

/**
 * Record the visible conversation from drawer:visible-conversation. null means a project-level surface
 * occupies the screen. Used to route VS Code selections to the correct sibling.
 */
export function setVisibleConversation(id: string | null): void {
  visibleConvId = id
}

/** Watch a conversation's .maestrly directory when VS Code opens; idempotent. */
export async function watchConversation(convId: string, cwd: string): Promise<void> {
  if (!cwd) return
  // Delete and reinsert the sibling to move it to the end as the most recently opened editor.
  const set = convByCwd.get(cwd) ?? new Set<string>()
  set.delete(convId)
  set.add(convId)
  convByCwd.set(cwd, set)
  if (watchers.has(cwd)) return

  const dir = path.join(cwd, SELECTION_REL_DIR)
  try {
    await fsp.mkdir(dir, { recursive: true })
  } catch {
    return
  }
  // Remove any ephemeral selection left by a previous session.
  await fsp.unlink(path.join(dir, SELECTION_FILE)).catch(() => {})
  try {
    let debounce: ReturnType<typeof setTimeout> | undefined
    const w = watch(dir, (_event, filename) => {
      if (filename && filename.toString() !== SELECTION_FILE) return
      clearTimeout(debounce)
      debounce = setTimeout(() => void handleSelection(cwd), 60)
    })
    watchers.set(cwd, w)
  } catch {
    /* A failed watch disables selection forwarding only for this conversation. */
  }
}

/**
 * Route a cwd selection to the visible sibling, then the only sibling, then the most recently opened
 * editor. Handles shared worktrees (#322).
 */
function resolveTargetConv(cwd: string): string | undefined {
  const set = convByCwd.get(cwd)
  if (!set || set.size === 0) return undefined
  if (visibleConvId && set.has(visibleConvId)) return visibleConvId
  if (set.size === 1) return set.values().next().value
  let last: string | undefined
  for (const v of set) last = v // Set insertion order identifies the most recently opened editor
  return last
}

async function handleSelection(cwd: string): Promise<void> {
  const convId = resolveTargetConv(cwd)
  if (!convId) return
  const file = path.join(cwd, SELECTION_REL_DIR, SELECTION_FILE)
  let payload: SelectionPayload
  try {
    payload = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return
  }
  if (!payload?.ts || payload.ts === lastTs.get(cwd)) return // dedup
  lastTs.set(cwd, payload.ts)

  const rel = path.relative(cwd, payload.path) || path.basename(payload.path)
  const startLine = payload.kind === 'selection' ? payload.startLine : undefined
  const endLine = payload.kind === 'selection' ? payload.endLine : undefined

  if (win && !win.isDestroyed()) {
    safeWindowSend(win, `chat:reference:${convId}`, { path: rel, startLine, endLine })
    win.webContents.focus()
  }

  // Delete the consumed selection file. unlink triggers another watch event, but the next read returns
  // ENOENT without further effects.
  await fsp.unlink(file).catch(() => {})
}

/**
 * Stop watching one archived/deleted sibling. Close the shared watcher only after its last sibling
 * leaves, preserving bridges for remaining conversations (#322).
 */
export function unwatchConversation(convId: string, cwd: string): void {
  if (visibleConvId === convId) visibleConvId = null
  const set = convByCwd.get(cwd)
  if (set) {
    set.delete(convId)
    if (set.size > 0) return // retain the watcher while a sibling remains
    convByCwd.delete(cwd)
  }
  watchers.get(cwd)?.close()
  watchers.delete(cwd)
  lastTs.delete(cwd)
}

export function stopSelectionBridge(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
  lastTs.clear()
  convByCwd.clear()
  visibleConvId = null
}
