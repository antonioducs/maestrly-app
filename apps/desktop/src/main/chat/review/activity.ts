import { randomUUID } from 'node:crypto'
import type { Tool, ToolSet } from 'ai'
import type { ReviewActivity } from '../../../shared/review'
import type { SubagentSessionRecorder } from '../subagent-session'
import { applySubagentTextUpdate, type SubagentTextUpdate } from '../subagent-text-stream'
import { normalizeFindingPath } from './findings'

const NOTE_LIMIT = 240
const FILES_LIMIT = 8

type Emit = (activity: ReviewActivity) => void

function normalizedToolName(name: string): string {
  return /^subagent:[^:]+:(.+)$/.exec(name)?.[1] ?? name
}

function field(input: unknown, name: string): unknown {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)[name]
    : undefined
}

function text(input: unknown, name: string): string {
  const value = field(input, name)
  return typeof value === 'string' ? value.trim() : ''
}

function positive(input: unknown, name: string): number | undefined {
  const value = field(input, name)
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** The last thing a reviewer wrote between tool calls, as one short line. */
export function noteText(value: string): string {
  const paragraphs = value
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  return last.length > NOTE_LIMIT ? `…${last.slice(-(NOTE_LIMIT - 1))}` : last
}

/** What a tool call looks like before it returns. */
export function startedActivity(name: string, input: unknown, cwd: string): ReviewActivity {
  const id = randomUUID()
  if (name === 'git_diff') return { id, kind: 'diff', text: 'git_diff', status: 'running' }
  if (name === 'read') {
    const raw = text(input, 'path')
    const offset = positive(input, 'offset')
    const limit = positive(input, 'limit')
    const range = limit ? `${offset ?? 1}–${(offset ?? 1) + limit - 1}` : offset ? `${offset}–` : undefined
    const path = normalizeFindingPath(raw, cwd)
    return {
      id,
      kind: 'read',
      text: path ?? raw,
      ...(path ? { path } : {}),
      ...(range ? { range } : {}),
      status: 'running',
    }
  }
  if (name === 'grep' || name === 'glob') {
    const scope = normalizeFindingPath(text(input, 'path'), cwd)
    const include = text(input, 'include')
    const pattern = text(input, 'pattern')
    return {
      id,
      kind: name,
      text: [pattern, include && `(${include})`, scope && `in ${scope}`].filter(Boolean).join(' '),
      status: 'running',
    }
  }
  if (name === 'submit_findings' || name === 'record_verdicts' || name === 'record_checks') {
    return { id, kind: 'submit', text: name, status: 'running' }
  }
  return { id, kind: 'tool', text: name, status: 'running' }
}

/** Fills in what a tool returned: match and file counts, the files a search matched, and directories read. */
export function finishedActivity(
  activity: ReviewActivity,
  input: unknown,
  output: unknown,
  cwd: string
): ReviewActivity {
  const value = typeof output === 'string' ? output : ''
  const done: ReviewActivity = { ...activity, status: 'done' }
  if (activity.kind === 'read' && /^[^\n]*\/\n/.test(value)) {
    // A directory listing is not evidence about a file.
    const { path: _path, range: _range, ...rest } = done
    return rest
  }
  if (activity.kind === 'grep') {
    const count = Number(/^(\d+) match/.exec(value)?.[1] ?? 0)
    const files = value
      .split('\n')
      .slice(1)
      .flatMap((line) => {
        const match = /^(\S.*):$/.exec(line)
        const path = match ? normalizeFindingPath(match[1], cwd) : undefined
        return path ? [path] : []
      })
      .slice(0, FILES_LIMIT)
    return { ...done, count, ...(files.length ? { files } : {}) }
  }
  if (activity.kind === 'glob') {
    const files = value === 'No files found.' ? [] : value.split('\n').filter(Boolean)
    return { ...done, count: files.length }
  }
  if (activity.kind === 'submit') {
    for (const key of ['findings', 'verdicts', 'results']) {
      const list = field(input, key)
      if (Array.isArray(list)) return { ...done, count: list.length }
    }
  }
  return done
}

/**
 * A session recorder that turns a reviewer's tool calls and the text it writes between them into activity the person
 * can follow live. It stores nothing: reviewer transcripts are not kept.
 */
export function createReviewActivityRecorder(input: { cwd: string; emit: Emit }): SubagentSessionRecorder {
  const id = `review-activity:${randomUUID()}`
  let note: ReviewActivity | null = null
  let noteSource = ''
  const safeEmit = (activity: ReviewActivity): void => {
    try {
      input.emit(activity)
    } catch {
      // Following the review is best effort; it never fails a reviewer.
    }
  }
  const closeNote = (): void => {
    if (note) safeEmit({ ...note, status: 'done' })
    note = null
    noteSource = ''
  }
  return {
    id,
    available: false,
    summary: () => null,
    phase: () => undefined,
    text: (update: SubagentTextUpdate) => {
      noteSource = applySubagentTextUpdate(noteSource, update)
      const line = noteText(noteSource)
      if (!line) return
      note = { id: note?.id ?? randomUUID(), kind: 'note', text: line, status: 'running' }
      safeEmit(note)
    },
    instrumentTools: (tools: ToolSet) =>
      Object.fromEntries(
        Object.entries(tools).map(([rawName, raw]) => {
          const candidate = raw as Tool & { execute?: (...args: any[]) => unknown }
          if (typeof candidate.execute !== 'function') return [rawName, raw]
          const name = normalizedToolName(rawName)
          const execute = candidate.execute
          return [
            rawName,
            {
              ...candidate,
              execute: async (toolInput: unknown, options?: unknown) => {
                closeNote()
                const activity = startedActivity(name, toolInput, input.cwd)
                safeEmit(activity)
                try {
                  const output = await execute(toolInput, options)
                  safeEmit(finishedActivity(activity, toolInput, output, input.cwd))
                  return output
                } catch (error) {
                  safeEmit({ ...activity, status: 'failed' })
                  throw error
                }
              },
            },
          ]
        })
      ) as ToolSet,
    runtimeHandle: () => undefined,
    resumeOutcome: () => undefined,
    complete: () => closeNote(),
  }
}
