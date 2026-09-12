import os from 'node:os'
import path from 'node:path'
import { createReadStream, promises as fsp, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
export type LegacyCliKind = 'claude' | 'codex' | 'opencode' | 'chat'
import { execCli, whichBin } from './platform'

/**
 * Read external transcripts only for one-time pre-Chat conversation imports. Claude uses
 * ~/.claude/projects/<slug>/<id>.jsonl with a leading-dash real-cwd slug. Codex uses
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, filtered by session_meta cwd. OpenCode stores SQLite
 * history; use session list --format json and export <id> instead of its internal schema.
 * Claude's reader was validated live; other readers follow the mapped formats.
 */

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

const HOME = os.homedir()

/** Resolve cwd symlinks (such as /tmp to /private/tmp) to match the transcript slug. */
function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * Claude project-directory slug: replace every non-alphanumeric character with a dash, preserve
 * existing dashes, and retain the leading dash. Replacing only slash/dot breaks paths containing
 * underscores.
 */
function claudeSlug(cwd: string): string {
  return realCwd(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/** Claude session .jsonl path for (cwd, sessionId). */
export function claudeSessionFile(cwd: string, sessionId: string): string {
  const slug = claudeSlug(cwd)
  return path.join(HOME, '.claude', 'projects', slug, `${sessionId}.jsonl`)
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
  const raw = await fsp.readFile(file, 'utf8')
  const out: Record<string, unknown>[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* ignore a corrupt line */
    }
  }
  return out
}

/** Join text content supplied as a string or block array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string')
      .map((b) => (b as { text: string }).text)
      .join('\n')
  }
  return ''
}

const isCommand = (s: string) => /<command-(name|message|args)>|<local-command-stdout>/.test(s)

// Keep historical markers local: the templates that generated them are no longer part of the product.
const LEGACY_HANDOFF_BOOTSTRAP_MARKERS = [
  'We are continuing a conversation that came from another AI tool.',
  'You are resuming this conversation. While you were away, part of the work continued',
  'Estamos continuando uma conversa que vinha de outra ferramenta de IA.',
  'Você está retomando esta conversa. Enquanto esteve fora, parte do trabalho continuou',
]

/** Legacy operational prompt that must not become an imported conversation message. */
function isLegacyBootstrapPrompt(text: string): boolean {
  if (!text.includes('.agent-handoff.md')) return false
  return LEGACY_HANDOFF_BOOTSTRAP_MARKERS.some((marker) => text.includes(marker))
}

function shouldSkipTurn(role: 'user' | 'assistant', text: string): boolean {
  return isCommand(text) || (role === 'user' && isLegacyBootstrapPrompt(text))
}

// ---------- Claude ----------
async function readClaude(cwd: string, sessionId: string): Promise<Turn[]> {
  const slug = claudeSlug(cwd)
  const dir = path.join(HOME, '.claude', 'projects', slug)
  const file = path.join(dir, `${sessionId}.jsonl`)
  try {
    await fsp.access(file)
  } catch {
    return []
  }
  const lines = await readLines(file)
  const turns: Turn[] = []
  for (const l of lines) {
    if (l.type !== 'user' && l.type !== 'assistant') continue // descarta plumbing
    if ((l.isSidechain as boolean) === true) continue // descarta subagentes
    const msg = l.message as { content?: unknown } | undefined
    const text = textOf(msg?.content).trim()
    const role = l.type as 'user' | 'assistant'
    if (!text || shouldSkipTurn(role, text)) continue
    turns.push({ role, text })
  }
  return turns
}

// ---------- Codex ----------
async function readCodex(cwd: string, cliSessionId?: string): Promise<Turn[]> {
  if (!cliSessionId) return []
  const root = path.join(HOME, '.codex', 'sessions')
  const target = realCwd(cwd)
  const files = await walk(root, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
  let best: { file: string; mtime: number } | null = null
  for (const f of files) {
    try {
      if (!path.basename(f).includes(cliSessionId)) continue
      const st = await fsp.stat(f)
      const header = await readCodexRolloutHeader(f)
      if (header?.meta.id === cliSessionId && realCwd(header.meta.cwd) === target) {
        if (!best || st.mtimeMs > best.mtime) best = { file: f, mtime: st.mtimeMs }
      }
    } catch {
      /* Ignore an unreadable or malformed file. */
    }
  }
  if (!best) return []
  const lines = await readLines(best.file)
  const turns: Turn[] = []
  for (const l of lines) {
    if (l.type !== 'response_item') continue
    const p = l.payload as { type?: string; role?: string; content?: unknown } | undefined
    if (p?.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue
    const text = textOf(p.content).trim()
    if (!text || shouldSkipTurn(p.role, text)) continue
    turns.push({ role: p.role, text })
  }
  return turns
}

// OpenCode stores history in SQLite rather than JSONL. Use official session list --format json and export
// <id> commands instead of opening the database. subscriptionEnv('opencode') preserves BYOK keys.

interface OpencodeSession {
  id: string
  /** Session cwd from the session list directory field. */
  directory: string
}

/** Run an OpenCode command and parse stdout as JSON. Return an empty array/null on failure. */
async function opencodeJson<T>(args: string[]): Promise<T | null> {
  try {
    const bin = whichBin('opencode') ?? 'opencode'
    const { stdout } = await execCli(bin, args, {
      env: { ...process.env },
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024, // long session exports may be large
    })
    return JSON.parse(stdout) as T
  } catch {
    return null
  }
}

/** OpenCode sessions whose directory matches the resolved cwd, in any order. */
async function opencodeSessions(cwd: string): Promise<OpencodeSession[]> {
  const target = realCwd(cwd)
  const raw = await opencodeJson<
    Array<{
      id?: string
      directory?: string
      updated?: number
      created?: number
    }>
  >(['session', 'list', '--format', 'json'])
  if (!Array.isArray(raw)) return []
  const out: OpencodeSession[] = []
  for (const s of raw) {
    if (!s?.id || !s.directory) continue
    if (realCwd(s.directory) !== target) continue
    out.push({ id: s.id, directory: s.directory })
  }
  return out
}

/** Extract turns from OpenCode export message roles and text parts. */
function opencodeTurns(exported: unknown): Turn[] {
  const messages = (exported as { messages?: unknown })?.messages
  if (!Array.isArray(messages)) return []
  const turns: Turn[] = []
  for (const m of messages) {
    const role = (m as { info?: { role?: string } })?.info?.role
    if (role !== 'user' && role !== 'assistant') continue
    const parts = (m as { parts?: unknown })?.parts
    const text = Array.isArray(parts)
      ? parts
          .filter((p) => (p as { type?: string })?.type === 'text' && typeof (p as { text?: string }).text === 'string')
          .map((p) => (p as { text: string }).text)
          .join('\n')
          .trim()
      : ''
    if (!text || shouldSkipTurn(role, text)) continue
    turns.push({ role, text })
  }
  return turns
}

/**
 * Read the exact native OpenCode session when knownId is available. Otherwise fall back to the newest
 * cwd session with mtime at least since, matching the other transcript recovery heuristics. Exact IDs prevent
 * importing a sibling conversation sharing the cwd.
 */
async function readOpencode(cwd: string, knownId?: string): Promise<Turn[]> {
  if (!knownId) return []
  const sessions = await opencodeSessions(cwd)
  if (!sessions.some((session) => session.id === knownId)) return []
  return opencodeTurns(await opencodeJson(['export', knownId]))
}

// Maestrly Chat history lives in native SQLite, not JSONL. This projection also recovers legacy
// conversations that switched between Chat and an external CLI.
async function readChat(conversationId: string): Promise<Turn[]> {
  const { listChatMessages } = await import('./chat/chat-store')
  const { generatedImageReference } = await import('./chat/message')
  const turns: Turn[] = []
  for (const message of listChatMessages(conversationId)) {
    const text = message.parts
      .map((part) => {
        if (part.type === 'text') return part.text
        if (part.type === 'compaction') return `(context summary)\n${part.text}`
        if (part.type === 'context') return part.text
        if (part.type === 'generated-image') return generatedImageReference(part)
        if (part.type === 'skill-invocation') return `[invoked skill /${part.name}${part.args ? ` ${part.args}` : ''}]`
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) turns.push({ role: message.role, text })
  }
  return turns
}

async function walk(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full, match)))
    else if (e.isFile() && match(e.name)) out.push(full)
  }
  return out
}

/** Read the exact external session for one-time import; never choose by recency or cwd. */
export async function readTranscript(
  cli: LegacyCliKind,
  cwd: string,
  sessionId: string,
  opts?: {
    strict?: boolean
    cliSessionId?: string
    requireExactSession?: boolean
  }
): Promise<Turn[]> {
  try {
    if (cli === 'chat') return await readChat(sessionId)
    if (cli === 'claude') return await readClaude(cwd, sessionId)
    if (cli === 'codex') return await readCodex(cwd, opts?.cliSessionId)
    return await readOpencode(cwd, opts?.cliSessionId)
  } catch (err) {
    console.error(`[transcript-reader] failed to read ${cli}:`, (err as Error).message)
    return []
  }
}

interface CodexSessionMeta {
  id: string
  cwd: string
}

interface CodexRolloutHeader {
  meta: CodexSessionMeta
}

const MAX_CODEX_PREAMBLE_LINES = 64

/**
 * Read only the rollout preamble. The first session_meta identifies this file; later entries may copy
 * parent metadata into subagent rollouts. When a marker is needed, read only to the first user turn or
 * a defensive limit instead of loading a huge JSONL file.
 */
async function readCodexRolloutHeader(file: string): Promise<CodexRolloutHeader | null> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let meta: CodexSessionMeta | null = null
  let inspected = 0
  try {
    for await (const raw of lines) {
      if (!raw.trim()) continue
      if (++inspected > MAX_CODEX_PREAMBLE_LINES) break
      let line: Record<string, unknown>
      try {
        line = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // A file still being written may have an incomplete first line; polling retries later.
        return null
      }

      if (!meta) {
        if (line.type !== 'session_meta') return null
        const payload = line.payload as
          | {
              id?: unknown
              cwd?: unknown
            }
          | undefined
        if (typeof payload?.id !== 'string' || typeof payload.cwd !== 'string') return null
        meta = {
          id: payload.id,
          cwd: payload.cwd,
        }
        return { meta }
      }
    }
    return meta ? { meta } : null
  } finally {
    lines.close()
    input.destroy()
  }
}
