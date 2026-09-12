import type { BrowserWindow } from 'electron'
import {
  createShellPty,
  clearPtyOutput,
  forgetPty,
  sendPtyData,
  sendPtyExit,
  getPtyInfo,
  killPty,
  killPtyAndWait,
  ptyExists,
  writePty,
} from './pty-manager'
import * as windowIpc from './window-ipc'
import { registerIdleCwdResource, tryAcquireCwdActivity } from './cwd-activity-coordinator'

/**
 * Main owns conversation-isolated drawer shell terminals for UI IPC and MCP. Push
 * drawer:terminal-state so the renderer is a passive view. pty-manager owns sessions with
 * term:<convId>:<n> IDs and buffered output; this module stores per-conversation tab lists and active
 * tabs. MCP reads and TerminalView mount replay share the PTY ring buffer.
 */

export interface TermTab {
  id: string
  cwd: string
  /** Optional tab label, e.g. "Codex — review"; absent means a regular numbered terminal. */
  label?: string
  /** Runtime-only Maestro delegation owner. */
  ownerScopeId?: string
}

export interface CreateShellTerminalOptions {
  ownerScopeId?: string
  label?: string
  /** Defaults to true for UI/unscoped terminals. Scoped workers create in background. */
  activate?: boolean
}

const termsByConv = new Map<string, TermTab[]>()
const activeByConv = new Map<string, string | null>()
let termSeq = 0
const idleTermReleases = new Map<string, () => void>()
const terminalActivityReleases = new Map<string, () => void>()
const terminalActivityPolls = new Map<string, ReturnType<typeof setInterval>>()

/** Retain some completed-tab history while bounding each conversation's list. */
export const MAX_RETAINED_TERMINAL_TABS = 16

export function initTerminalManager(_window: BrowserWindow): void {}

// Injected floating-manager hook raises a floating terminal window and returns true without creating an
// import cycle. Used on focus/create.
let floatFocuser: ((convId: string, tab: 'terminal') => boolean) | null = null
export function setTerminalFloatFocuser(fn: (convId: string, tab: 'terminal') => boolean): void {
  floatFocuser = fn
}

// Injected popup hook raises an existing terminal popup without opening one. App-tool focus preserves the
// user's chosen drawer/floating/popup presentation.
let popupFocuser: ((convId: string, tab: 'terminal') => void) | null = null
export function setTerminalPopupFocuser(fn: (convId: string, tab: 'terminal') => void): void {
  popupFocuser = fn
}

// Direct terminal streams to their conversation panel. The fallback supports older harnesses and early
// boot; production never broadcasts them globally.
const sendPanel = (convId: string, panel: string, channel: string, payload: unknown): void => {
  if (typeof windowIpc.sendToPanel === 'function') windowIpc.sendToPanel(convId, panel, channel, payload)
  else windowIpc.broadcast(channel, payload)
}
const sendConversation = (convId: string, channel: string, payload: unknown, panel?: string): void => {
  if (typeof windowIpc.sendToConversation === 'function') {
    windowIpc.sendToConversation(convId, channel, payload, panel ? { panel } : undefined)
  } else windowIpc.broadcast(channel, payload)
}

function list(convId: string): TermTab[] {
  return termsByConv.get(convId) ?? []
}

/**
 * Current conversation terminal list and active ID for panel mount hydration; drawer:terminal-state
 * emits only on changes.
 */
export function getTerminalState(convId: string): { terminals: TermTab[]; activeId: string | null } {
  return { terminals: list(convId), activeId: activeByConv.get(convId) ?? null }
}

/**
 * Canonical terminal cwd registered by main, or null for an unknown ID. Shell creation must use this
 * rather than trusting renderer cwd (#264).
 */
export function shellTermCwd(id: string): string | null {
  for (const tabs of termsByConv.values()) {
    const t = tabs.find((x) => x.id === id)
    if (t) return t.cwd
  }
  return null
}

function clearTerminalActivity(id: string): void {
  const poll = terminalActivityPolls.get(id)
  if (poll) clearInterval(poll)
  terminalActivityPolls.delete(id)
  terminalActivityReleases.get(id)?.()
  terminalActivityReleases.delete(id)
}

function releaseTerminalResources(id: string): void {
  clearTerminalActivity(id)
  idleTermReleases.get(id)?.()
  idleTermReleases.delete(id)
  // terminal_clear semantics: retain generation/sequence/totalChars while only dropping the heavy
  // replay deque. Final identity teardown happens separately, after the id is no longer reusable.
  clearPtyOutput(id)
}

function forgetTerminalResources(id: string): void {
  releaseTerminalResources(id)
  forgetPty(id)
}

/**
 * Evict only tabs whose PTY is already dead. A live shell is never killed for memory
 * pressure; if every tab is still running, the soft cap is intentionally exceeded.
 */
function pruneCompletedTerminalTabs(convId: string, protectedId?: string): boolean {
  const tabs = list(convId)
  const excess = tabs.length - MAX_RETAINED_TERMINAL_TABS
  if (excess <= 0) return false
  const evictedIds = new Set(
    tabs
      // The new tab is inserted before the synchronous spawn call. Keep it in the list while the
      // PTY is being created; otherwise 16 live tabs plus one new tab would evict the new tab and
      // leave its freshly spawned PTY orphaned from the manager's state.
      .filter((tab) => tab.id !== protectedId && !ptyExists(tab.id))
      .slice(0, excess)
      .map((tab) => tab.id)
  )
  if (evictedIds.size === 0) return false
  for (const id of evictedIds) forgetTerminalResources(id)
  const next = tabs.filter((tab) => !evictedIds.has(tab.id))
  if (next.length === 0) {
    termsByConv.delete(convId)
    activeByConv.delete(convId)
  } else {
    termsByConv.set(convId, next)
    if (activeByConv.get(convId) && evictedIds.has(activeByConv.get(convId)!)) {
      activeByConv.set(convId, next.at(-1)?.id ?? null)
    }
  }
  return true
}

function shellProcess(id: string): string {
  const processName =
    getPtyInfo(id)
      ?.process.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  return processName.split(/[\\/]/).at(-1) ?? processName
}

function processIsIdleShell(processName: string): boolean {
  return ['bash', 'zsh', 'fish', 'sh', 'dash', 'cmd', 'powershell', 'pwsh'].includes(processName)
}

function holdTerminalActivityUntilIdle(id: string, cwd: string): boolean {
  if (terminalActivityReleases.has(id)) return true
  const release = tryAcquireCwdActivity(cwd, 'terminal')
  if (!release) return false
  terminalActivityReleases.set(id, release)

  // On POSIX, node-pty exposes the foreground process and releases the lease when it returns to the shell.
  // Windows reports only the initial shell, so retain the lease until terminal close instead of timing out
  // while a long command may still write.
  if (process.platform !== 'win32') {
    let sawForeground = false
    const startedAt = Date.now()
    terminalActivityPolls.set(
      id,
      setInterval(() => {
        if (!ptyExists(id)) return clearTerminalActivity(id)
        const processName = shellProcess(id)
        if (!processName) return
        if (!processIsIdleShell(processName)) sawForeground = true
        else if (sawForeground || Date.now() - startedAt >= 1000) clearTerminalActivity(id)
      }, 200)
    )
  }
  return true
}

/** Central terminal writes; Enter keeps cwd locked while a foreground command runs. */
export function writeShellTerminal(id: string, data: string): boolean {
  const cwd = shellTermCwd(id)
  if (!cwd || !ptyExists(id)) return false
  const submitsCommand = /\r|\n/.test(data)
  if (submitsCommand && !holdTerminalActivityUntilIdle(id, cwd)) return false
  const release = submitsCommand ? null : tryAcquireCwdActivity(cwd, 'terminal')
  if (!submitsCommand && !release) return false
  try {
    writePty(id, data)
    return true
  } finally {
    release?.()
  }
}

function emitTerminalState(convId: string): void {
  // Always emit, including background conversations. The renderer stores by convId and displays it when
  // that conversation opens.
  sendPanel(convId, 'terminal', 'drawer:terminal-state', {
    convId,
    terminals: list(convId),
    activeId: activeByConv.get(convId) ?? null,
  })
}

/**
 * Create a conversation shell terminal for UI/MCP and return its PTY ID. Default 120x40 matches
 * terminal_snapshot's headless screen for background terminals; mounted TerminalView's ResizeObserver
 * adjusts to actual dimensions.
 */
export type ShellTerminalCreateResult = { ok: true; id: string } | { ok: false; reason: 'cwd-locked' | 'spawn-failed' }

export function createShellTerminal(
  convId: string,
  cwd: string,
  cols = 120,
  rows = 40,
  options: CreateShellTerminalOptions = {}
): ShellTerminalCreateResult {
  const releaseActivity = tryAcquireCwdActivity(cwd, 'terminal')
  if (!releaseActivity) return { ok: false, reason: 'cwd-locked' }
  try {
    const previousActiveId = activeByConv.get(convId) ?? null
    const id = `term:${convId}:${++termSeq}`
    const tab: TermTab = { id, cwd }
    if (options.ownerScopeId) tab.ownerScopeId = options.ownerScopeId
    if (options.label) tab.label = options.label
    const tabs = [...list(convId), tab]
    termsByConv.set(convId, tabs)
    if (options.activate ?? true) activeByConv.set(convId, id)
    pruneCompletedTerminalTabs(convId, id)
    // An idle live shell is a preview warning; only the short spawn interval blocks cwd activity.
    let exitedDuringSpawn = false
    const releaseIdle = registerIdleCwdResource(cwd, 'terminal')
    idleTermReleases.set(id, releaseIdle)
    createShellPty({
      id,
      cwd,
      cols,
      rows,
      onData: (data, meta) => sendPtyData(id, data, meta),
      onExit: (code, isCurrent, generation) => {
        if (isCurrent !== false) exitedDuringSpawn = true
        // This release belongs to the callback's generation. It is safe (and necessary) to run it
        // for an old exit too; only the id-keyed activity state below is protected by isCurrent.
        releaseIdle()
        if (isCurrent !== false) {
          clearTerminalActivity(id)
          if (idleTermReleases.get(id) === releaseIdle) idleTermReleases.delete(id)
        }
        sendPtyExit(id, code, generation)
        if (isCurrent !== false && pruneCompletedTerminalTabs(convId)) emitTerminalState(convId)
      },
    })
    if (exitedDuringSpawn) {
      forgetTerminalResources(id)
      const remaining = list(convId).filter((tab) => tab.id !== id)
      if (remaining.length === 0) {
        termsByConv.delete(convId)
        activeByConv.delete(convId)
      } else {
        termsByConv.set(convId, remaining)
        // Background worker terminals never own the user's active tab. An activating create temporarily
        // points at the failed id and therefore restores the prior active tab (or a live fallback).
        if (options.activate ?? true) {
          const restored =
            previousActiveId && remaining.some((terminal) => terminal.id === previousActiveId)
              ? previousActiveId
              : (remaining.at(-1)?.id ?? null)
          activeByConv.set(convId, restored)
        }
      }
      emitTerminalState(convId)
      return { ok: false, reason: 'spawn-failed' }
    }
    emitTerminalState(convId)
    return { ok: true, id }
  } finally {
    releaseActivity()
  }
}

/** Close a shell PTY, remove its tab, and update active selection. */
export function closeShellTerminal(convId: string, id: string): void {
  killPty(id)
  forgetTerminalResources(id)
  const next = list(convId).filter((t) => t.id !== id)
  if (next.length === 0) {
    termsByConv.delete(convId)
    activeByConv.delete(convId)
  } else {
    termsByConv.set(convId, next)
    if (activeByConv.get(convId) === id) activeByConv.set(convId, next[next.length - 1]?.id ?? null)
  }
  emitTerminalState(convId)
}

/** Set the active terminal tab through UI or programmatic focus. */
export function setActiveShellTerminal(convId: string, id: string | null): void {
  if (id === null && list(convId).length === 0) activeByConv.delete(convId)
  else activeByConv.set(convId, id)
  emitTerminalState(convId)
}

/** Move a terminal tab from one index to another by dragging. Session-only because PTYs are ephemeral. */
export function reorderShellTerminal(convId: string, from: number, to: number): void {
  const tabs = [...list(convId)]
  const n = tabs.length
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return
  const [tab] = tabs.splice(from, 1)
  tabs.splice(to, 0, tab)
  termsByConv.set(convId, tabs)
  emitTerminalState(convId)
}

/** Activate the terminal tab and ask the renderer to focus it. */
export function focusShellTerminal(convId: string, id: string): void {
  setActiveShellTerminal(convId, id) // emite terminal-state (vira a aba ativa)
  // Ask App to open this conversation's Terminal drawer, then send terminal:focus to focus its xterm by ID;
  // the main session is unaffected.
  sendConversation(convId, 'drawer:terminal-focus', { convId, id }, 'terminal')
  sendConversation(convId, 'terminal:focus', id, 'terminal')
  floatFocuser?.(convId, 'terminal') // raise the floating terminal window
  popupFocuser?.(convId, 'terminal') // raise an existing popup without opening one
}

/** Live conversation terminals, excluding exited PTYs; used by MCP terminal_list. */
export function listShellTerminals(convId: string): TermTab[] {
  return list(convId).filter((t) => ptyExists(t.id))
}

/** Runtime ownership helpers for Maestro-scoped terminal tools and cleanup. */
export function getShellTerminalOwnerScopeId(convId: string, id: string): string | undefined {
  return list(convId).find((terminal) => terminal.id === id)?.ownerScopeId
}

export function listShellTerminalsOwnedByScope(convId: string, ownerScopeId: string): TermTab[] {
  return list(convId).filter((terminal) => terminal.ownerScopeId === ownerScopeId)
}

/** Check terminal ownership within this conversation for MCP tool authorization. */
export function isShellOfConv(convId: string, id: string): boolean {
  return id.startsWith(`term:${convId}:`)
}

/**
 * Close and remove all conversation terminals on archive/delete/workspace removal. Do not emit state
 * while destroying the conversation: renderer reconciliation removes it, and a racing empty state
 * could recreate an orphan entry.
 */
export function disposeShellTerminals(convId: string): void {
  for (const t of list(convId)) {
    killPty(t.id)
    forgetTerminalResources(t.id)
  }
  termsByConv.delete(convId)
  activeByConv.delete(convId)
}

export async function disposeShellTerminalsAndWait(convId: string): Promise<boolean> {
  const terminals = [...list(convId)]
  // Remove the tabs from the authority before awaiting exits. A queued pty:create must not find a
  // shell cwd and respawn a terminal while this conversation is being destroyed.
  termsByConv.delete(convId)
  activeByConv.delete(convId)
  for (const terminal of terminals) releaseTerminalResources(terminal.id)
  const exits = await Promise.all(
    terminals.map(async (terminal) => {
      const exited = await killPtyAndWait(terminal.id)
      forgetTerminalResources(terminal.id)
      return exited
    })
  )
  return exits.every(Boolean)
}
