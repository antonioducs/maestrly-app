import os from 'node:os'
import { z } from 'zod'
import headless from '@xterm/headless'
import {
  createShellTerminal,
  closeShellTerminal,
  listShellTerminals,
  listShellTerminalsOwnedByScope,
  focusShellTerminal,
  getShellTerminalOwnerScopeId,
  isShellOfConv,
  writeShellTerminal,
} from '../../terminal-manager'
import {
  readPtyOutput,
  readPtyOutputSnapshot,
  readPtyOutputStats,
  clearPtyOutput,
  signalPty,
  getPtyInfo,
  ptyExists,
} from '../../pty-manager'
import { resizePty } from '../../pty-manager'
import { getConversation } from '../../store'
import type { McpToolContext } from './context'
import { ok, err } from './context'
import type { PtyOutputStats } from '../../../shared/pty'

const { Terminal: HeadlessTerminal } = headless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

export function registerTerminalTools(ctx: McpToolContext): void {
  const { server, convId, t, workerScope } = ctx
  if (workerScope && workerScope.conversationId !== convId) {
    throw new Error('Maestro worker scope conversation does not match the terminal tool context.')
  }
  // Drawer terminal tools operate only on this conversation's term:<convId>:* IDs. Reject the main agent
  // session and terminals owned by other conversations.
  const TERM_NOTE = t('notes.term')
  /** Validate that the terminal exists and belongs to this conversation; otherwise return an error. */
  const guard = (id: string): string | null => {
    if (workerScope && getShellTerminalOwnerScopeId(convId, id) !== workerScope.id) {
      return t('errors.notTermOfConv', { id })
    }
    if (!isShellOfConv(convId, id)) return t('errors.notTermOfConv', { id })
    if (!ptyExists(id)) return t('errors.termNotExist', { id })
    return null
  }
  type TerminalToolResult = ReturnType<typeof ok> | ReturnType<typeof err>
  const runForTerminal = <T>(id: string, operation: () => T | Promise<T>): Promise<T> => {
    if (!workerScope) return Promise.resolve(operation())
    return workerScope.runExclusive(`terminal:${convId}:${id}`, operation)
  }
  const runGuarded = (
    id: string,
    operation: () => TerminalToolResult | Promise<TerminalToolResult>
  ): Promise<TerminalToolResult> =>
    runForTerminal(id, async () => {
      const error = guard(id)
      if (error) return err(error)
      return operation()
    })

  if (workerScope) {
    workerScope.registerCleanup(`terminal:${convId}`, () => {
      for (const terminal of listShellTerminalsOwnedByScope(convId, workerScope.id)) {
        if (getShellTerminalOwnerScopeId(convId, terminal.id) === workerScope.id) {
          closeShellTerminal(convId, terminal.id)
        }
      }
    })
  }

  server.registerTool(
    'terminal_create',
    {
      title: t('tools.terminal_create.title'),
      description: t('tools.terminal_create.description') + TERM_NOTE,
      inputSchema: {
        cwd: z.string().optional().describe(t('tools.terminal_create.params.cwd')),
        cols: z.number().int().optional().describe(t('tools.terminal_create.params.cols')),
        rows: z.number().int().optional().describe(t('tools.terminal_create.params.rows')),
      },
    },
    async ({ cwd, cols, rows }) => {
      const create = () => {
        const dir = cwd || getConversation(convId)?.cwd || os.homedir() // use os.homedir() because Windows may lack HOME
        const result = workerScope
          ? createShellTerminal(convId, dir, cols, rows, {
              ownerScopeId: workerScope.id,
              label: workerScope.label,
              activate: false,
            })
          : createShellTerminal(convId, dir, cols, rows)
        if (!result.ok) {
          if (result.reason === 'cwd-locked') return err(t('errors.termCwdLocked'))
          return err(t('errors.termSpawnFailed'))
        }
        return ok(t('returns.terminal.created', { id: result.id, cwd: dir }))
      }
      return workerScope ? workerScope.runExclusive(`terminal-create:${convId}`, create) : create()
    }
  )

  server.registerTool(
    'terminal_list',
    {
      title: t('tools.terminal_list.title'),
      description: t('tools.terminal_list.description') + TERM_NOTE,
      inputSchema: {},
    },
    async () => {
      const getTerminals = () =>
        workerScope
          ? listShellTerminals(convId).filter(
              (terminal) => getShellTerminalOwnerScopeId(convId, terminal.id) === workerScope.id
            )
          : listShellTerminals(convId)
      const ts = workerScope ? await workerScope.runExclusive(`terminal-list:${convId}`, getTerminals) : getTerminals()
      if (ts.length === 0) return ok(t('returns.terminal.none'))
      const lines = ts.map((term) => {
        const info = getPtyInfo(term.id)
        return `- ${term.id}  cwd=${term.cwd}  pid=${info?.pid ?? '?'}  proc=${info?.process ?? '?'}`
      })
      return ok(lines.join('\n'))
    }
  )

  server.registerTool(
    'terminal_send',
    {
      title: t('tools.terminal_send.title'),
      description: t('tools.terminal_send.description') + TERM_NOTE,
      inputSchema: {
        id: z.string().describe(t('tools.terminal_send.params.id')),
        text: z.string().describe(t('tools.terminal_send.params.text')),
      },
    },
    async ({ id, text }) => {
      return runGuarded(id, () => {
        if (!writeShellTerminal(id, text)) return err(t('errors.termCwdLocked'))
        return ok(t('returns.terminal.sent', { chars: text.length, id }))
      })
    }
  )

  server.registerTool(
    'terminal_run',
    {
      title: t('tools.terminal_run.title'),
      description: t('tools.terminal_run.description') + TERM_NOTE,
      inputSchema: {
        id: z.string().describe(t('tools.terminal_run.params.id')),
        command: z.string().describe(t('tools.terminal_run.params.command')),
        timeout_ms: z.number().int().optional().describe(t('tools.terminal_run.params.timeoutMs')),
      },
    },
    async ({ id, command, timeout_ms }) => {
      return runGuarded(id, async () => {
        const before = readPtyOutputStats(id)
        if (!writeShellTerminal(id, command + '\r')) return err(t('errors.termCwdLocked'))
        const out = await waitForOutput(id, before, timeout_ms ?? 8000, workerScope?.signal)
        return ok(out || t('returns.terminal.runNoOutput'))
      })
    }
  )

  server.registerTool(
    'terminal_read',
    {
      title: t('tools.terminal_read.title'),
      description: t('tools.terminal_read.description') + TERM_NOTE,
      inputSchema: {
        id: z.string().describe(t('tools.terminal_read.params.id')),
        max_chars: z.number().int().optional().describe(t('tools.terminal_read.params.maxChars')),
      },
    },
    async ({ id, max_chars }) => {
      return runGuarded(id, () => ok(stripAnsi(readPtyOutput(id, max_chars)) || t('returns.terminal.readEmpty')))
    }
  )

  server.registerTool(
    'terminal_snapshot',
    {
      title: t('tools.terminal_snapshot.title'),
      description: t('tools.terminal_snapshot.description') + TERM_NOTE,
      inputSchema: { id: z.string().describe(t('tools.terminal_snapshot.params.id')) },
    },
    async ({ id }) => {
      return runGuarded(id, async () =>
        ok((await renderScreen(readPtyOutput(id))) || t('returns.terminal.screenEmpty'))
      )
    }
  )

  server.registerTool(
    'terminal_signal',
    {
      title: t('tools.terminal_signal.title'),
      description: t('tools.terminal_signal.description') + TERM_NOTE,
      inputSchema: {
        id: z.string().describe(t('tools.terminal_signal.params.id')),
        signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']).describe(t('tools.terminal_signal.params.signal')),
      },
    },
    async ({ id, signal }) => {
      return runGuarded(id, () => {
        signalPty(id, signal)
        return ok(t('returns.terminal.signalSent', { signal, id }))
      })
    }
  )

  server.registerTool(
    'terminal_close',
    {
      title: t('tools.terminal_close.title'),
      description: t('tools.terminal_close.description') + TERM_NOTE,
      inputSchema: { id: z.string().describe(t('tools.terminal_close.params.id')) },
    },
    async ({ id }) => {
      if (workerScope) {
        return runForTerminal(id, () => {
          if (getShellTerminalOwnerScopeId(convId, id) !== workerScope.id) {
            return err(t('errors.notTermOfConv', { id }))
          }
          closeShellTerminal(convId, id)
          return ok(t('returns.terminal.closed', { id }))
        })
      }
      if (!isShellOfConv(convId, id)) return err(t('errors.notTermOfConv', { id }))
      closeShellTerminal(convId, id)
      return ok(t('returns.terminal.closed', { id }))
    }
  )

  server.registerTool(
    'terminal_resize',
    {
      title: t('tools.terminal_resize.title'),
      description: t('tools.terminal_resize.description') + TERM_NOTE,
      inputSchema: {
        id: z.string().describe(t('tools.terminal_resize.params.id')),
        cols: z.number().int().describe(t('tools.terminal_resize.params.cols')),
        rows: z.number().int().describe(t('tools.terminal_resize.params.rows')),
      },
    },
    async ({ id, cols, rows }) => {
      return runGuarded(id, () => {
        resizePty(id, cols, rows)
        return ok(t('returns.terminal.resized', { id, cols, rows }))
      })
    }
  )

  server.registerTool(
    'terminal_focus',
    {
      title: t('tools.terminal_focus.title'),
      description: t('tools.terminal_focus.description') + TERM_NOTE,
      inputSchema: { id: z.string().describe(t('tools.terminal_focus.params.id')) },
    },
    async ({ id }) => {
      return runGuarded(id, () => {
        focusShellTerminal(convId, id)
        return ok(t('returns.terminal.focused', { id }))
      })
    }
  )

  server.registerTool(
    'terminal_clear',
    {
      title: t('tools.terminal_clear.title'),
      description: t('tools.terminal_clear.description') + TERM_NOTE,
      inputSchema: { id: z.string().describe(t('tools.terminal_clear.params.id')) },
    },
    async ({ id }) => {
      return runGuarded(id, () => {
        clearPtyOutput(id)
        return ok(t('returns.terminal.bufferCleared', { id }))
      })
    }
  )
}

/** Strip ANSI/escape sequences for readable textual tool output. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
}

/**
 * terminal_run waits until no new PTY bytes arrive for quietMs or timeout, then returns output since
 * the initial cursor. This is heuristic, as documented in the tool description.
 */
async function waitForOutput(
  id: string,
  before: PtyOutputStats,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const quietMs = 500
  const start = Date.now()
  let lastStats = before
  let lastChange = Date.now()
  // Allow a short initial delay for command output to begin.
  await new Promise((r) => setTimeout(r, 120))
  for (;;) {
    signal?.throwIfAborted()
    await new Promise((r) => setTimeout(r, 100))
    signal?.throwIfAborted()
    if (!ptyExists(id)) break // terminal exited; return without waiting for timeout
    const stats = readPtyOutputStats(id)
    if (
      stats.generation !== lastStats.generation ||
      stats.sequence !== lastStats.sequence ||
      stats.totalChars !== lastStats.totalChars
    ) {
      lastStats = stats
      lastChange = Date.now()
    }
    const hasNew =
      stats.generation !== before.generation ||
      stats.sequence !== before.sequence ||
      stats.totalChars !== before.totalChars
    const quiesced = Date.now() - lastChange >= quietMs && hasNew
    if (quiesced || Date.now() - start >= timeoutMs) break
  }
  const snapshot = readPtyOutputSnapshot(id)
  if (snapshot.generation !== before.generation) return stripAnsi(snapshot.data).trim()

  const deltaChars = snapshot.totalChars - before.totalChars
  if (deltaChars <= 0) return ''
  // If the absolute cursor predates the ring after rollover/clear, only the current snapshot is reliable.
  // Otherwise the final deltaChars are new output.
  const delta = deltaChars > snapshot.bufferedLength ? snapshot.data : snapshot.data.slice(-deltaChars)
  return stripAnsi(delta).trim()
}

/**
 * Render raw output in an ephemeral headless xterm and return visible lines. Await its write callback
 * because parsing is asynchronous.
 */
async function renderScreen(raw: string): Promise<string> {
  const term = new HeadlessTerminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 0 })
  await new Promise<void>((resolve) => term.write(raw, () => resolve()))
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    lines.push(line ? line.translateToString(true) : '')
  }
  term.dispose()
  return lines.join('\n').replace(/\s+$/, '')
}
