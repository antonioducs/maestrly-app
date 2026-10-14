import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ReviewCodeScope, ReviewFinding, ReviewPlanScope, ReviewSnippet } from '../../../shared/review'
import type { DiffStats } from './git-diff'

const SCOPE_FILES_LIMIT = 60
const SNIPPET_CONTEXT = 3
const SNIPPET_LINE_LIMIT = 400
const SNIPPET_FILE_LIMIT = 2 * 1024 * 1024

/** The change as the scope stage shows it: largest files first, with totals over every file. */
export function codeScope(stats: DiffStats): ReviewCodeScope {
  const size = (file: DiffStats['files'][number]) => (file.added ?? 0) + (file.deleted ?? 0)
  const files = [...stats.files].sort((a, b) => size(b) - size(a) || a.path.localeCompare(b.path))
  return {
    kind: 'code',
    branch: stats.branch,
    head: stats.head,
    files: files.slice(0, SCOPE_FILES_LIMIT).map((file) => ({
      path: file.path,
      ...(file.added !== undefined ? { added: file.added } : {}),
      ...(file.deleted !== undefined ? { deleted: file.deleted } : {}),
      ...(file.isNew ? { isNew: true } : {}),
    })),
    filesTotal: files.length,
    added: files.reduce((total, file) => total + (file.added ?? 0), 0),
    deleted: files.reduce((total, file) => total + (file.deleted ?? 0), 0),
  }
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/
const STEP = /^(?:\d+[.)]|[-*+])\s+(.*)$/

function plainText(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .trim()
}

/** The plan's title and its top-level steps (or, when it has no list, its section headings). */
export function planScope(plan: string, version: number): ReviewPlanScope {
  const lines = plan.split('\n')
  let title: string | undefined
  const steps: string[] = []
  const headings: string[] = []
  let fence = false
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const heading = HEADING.exec(line)
    if (heading) {
      if (!title) title = plainText(heading[1])
      else headings.push(plainText(heading[1]))
      continue
    }
    // Only unindented list items: nested ones are details of a step.
    const step = STEP.exec(line)
    if (step) steps.push(plainText(step[1]))
  }
  const overview = (steps.length ? steps : headings).slice(0, 12).map((step) => step.slice(0, 300))
  return { kind: 'plan', version, ...(title ? { title: title.slice(0, 300) } : {}), steps: overview }
}

function snippetAround(
  lines: readonly string[],
  line: number,
  source: ReviewSnippet['source'],
  file?: string
): ReviewSnippet | null {
  if (line < 1 || line > lines.length) return null
  const start = Math.max(1, line - SNIPPET_CONTEXT)
  const end = Math.min(lines.length, line + SNIPPET_CONTEXT)
  return {
    source,
    ...(file ? { path: file } : {}),
    start,
    lines: lines.slice(start - 1, end).map((text) => text.replace(/\r$/, '').slice(0, SNIPPET_LINE_LIMIT)),
    highlight: line,
  }
}

/** Lines around `line` in a repository file; null when the file is outside the checkout, binary, large or missing. */
export async function fileSnippet(cwd: string, file: string, line: number): Promise<ReviewSnippet | null> {
  try {
    const root = await realpath(cwd)
    const full = await realpath(path.resolve(root, file))
    if (full !== root && !full.startsWith(root + path.sep)) return null
    if ((await stat(full)).size > SNIPPET_FILE_LIMIT) return null
    const text = await readFile(full, 'utf8')
    if (text.includes('\0')) return null
    const lines = text.split('\n')
    // A file that ends with a newline has no empty last line.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return snippetAround(lines, line, 'file', file)
  } catch {
    return null
  }
}

export function planSnippet(plan: string, line: number): ReviewSnippet | null {
  return snippetAround(plan.split('\n'), line, 'plan')
}

/** Attaches the lines each finding points at: the plan line for plan reviews, else the file and line. */
export async function withSnippets(
  findings: ReviewFinding[],
  input: { cwd: string; plan?: string }
): Promise<ReviewFinding[]> {
  return Promise.all(
    findings.map(async (finding) => {
      const snippet =
        input.plan !== undefined && finding.planLine
          ? planSnippet(input.plan, finding.planLine)
          : finding.path && finding.line
            ? await fileSnippet(input.cwd, finding.path, finding.line)
            : null
      return snippet ? { ...finding, snippet } : finding
    })
  )
}
