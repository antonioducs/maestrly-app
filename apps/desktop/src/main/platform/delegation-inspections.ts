/**
 * Typed inspections performed by the executor.
 *
 * Every operation is resolved by the host: paths stay inside the workspace, search and glob reuse the chat
 * tool primitives, and browser work runs only against a preview this task started. There is no arbitrary
 * shell and no path escape.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertWorkspaceRelativePath,
  type CodeRevision,
  type InspectionOperation,
} from '@maestrly/protocol'
import { createGitRunner } from './delegation-snapshot'

export const MAX_INSPECTION_TEXT_BYTES = 200_000
const MAX_READ_LINES = 2_000

export interface InspectionArtifact {
  kind: 'screenshot' | 'report' | 'log'
  name: string
  contentType: string
  bytes: Buffer
}

export interface InspectionOutcome {
  result: Record<string, unknown> | null
  artifact: InspectionArtifact | null
  codeRevisionDigest: string | null
}

export interface BrowserPreview {
  previewId: string
  snapshot(): Promise<Record<string, unknown>>
  screenshot(): Promise<Buffer>
  text(): Promise<string>
  console(limit: number): Promise<unknown[]>
  network(onlyErrors: boolean): Promise<unknown[]>
  navigate(url: string): Promise<{ url: string }>
  click(ref: number): Promise<void>
  type(ref: number, text: string, clear: boolean): Promise<void>
}

export interface InspectionDeps {
  cwd: string
  revision: CodeRevision | null
  /** Previews this task started; an unknown id is refused rather than resolved. */
  preview(previewId: string): BrowserPreview | null
  startPreview?(checkId: string): Promise<BrowserPreview>
  stopPreview?(previewId: string): Promise<void>
  pullRequest?(): Promise<Record<string, unknown>>
  listFiles?(cwd: string): Promise<string[]>
  searchFiles?(input: { cwd: string; pattern: string; include: string; limit: number }): Promise<
    Array<{ path: string; line: number; text: string }>
  >
}

/**
 * Glob matcher for workspace-relative paths. `**` crosses directories, `*` and `?` stay inside one segment,
 * and `{a,b}` offers alternatives. The pattern is anchored so a partial match never selects a file.
 */
export function delegationGlobToRegExp(pattern: string): RegExp {
  const literal = (value: string) => value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  let source = ''
  let index = 0
  while (index < pattern.length) {
    if (pattern.startsWith('/**/', index)) {
      source += '(?:/.*)?/'
      index += 4
      continue
    }
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?'
      index += 3
      continue
    }
    if (pattern.startsWith('**', index)) {
      source += '.*'
      index += 2
      continue
    }
    const character = pattern[index]!
    if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else if (character === '{') {
      const end = pattern.indexOf('}', index)
      if (end > index) {
        source += `(?:${pattern
          .slice(index + 1, end)
          .split(',')
          .map(literal)
          .join('|')})`
        index = end + 1
        continue
      }
      source += '\\{'
    } else source += literal(character)
    index += 1
  }
  return new RegExp(`^${source}$`)
}

function bounded(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= MAX_INSPECTION_TEXT_BYTES) return { text, truncated: false }
  return { text: bytes.subarray(0, MAX_INSPECTION_TEXT_BYTES).toString('utf8'), truncated: true }
}

/** Run one inspection. Anything the host cannot honor fails with a concrete reason instead of a guess. */
export async function runInspection(
  operation: InspectionOperation,
  deps: InspectionDeps
): Promise<InspectionOutcome> {
  const digest = deps.revision?.contentDigest ?? null
  switch (operation.kind) {
    case 'read_file': {
      const relative = assertWorkspaceRelativePath(operation.path)
      const absolute = path.resolve(deps.cwd, relative)
      if (absolute !== deps.cwd && !absolute.startsWith(deps.cwd + path.sep))
        throw new Error('The path must stay inside the workspace.')
      const content = await readFile(absolute, 'utf8')
      const lines = content.split('\n')
      const slice = lines.slice(operation.offset, operation.offset + Math.min(operation.limit, MAX_READ_LINES))
      const { text, truncated } = bounded(slice.join('\n'))
      return {
        result: { path: relative, offset: operation.offset, lines: slice.length, total: lines.length, text, truncated },
        artifact: null,
        codeRevisionDigest: digest,
      }
    }
    case 'search': {
      if (!deps.searchFiles) throw new Error('This executor cannot search the workspace.')
      const matches = await deps.searchFiles({
        cwd: deps.cwd,
        pattern: operation.pattern,
        include: operation.include,
        limit: operation.limit,
      })
      return { result: { matches, count: matches.length }, artifact: null, codeRevisionDigest: digest }
    }
    case 'glob': {
      if (!deps.listFiles) throw new Error('This executor cannot list the workspace.')
      const regex = delegationGlobToRegExp(operation.pattern)
      const files = (await deps.listFiles(deps.cwd)).filter((file) => regex.test(file)).slice(0, operation.limit)
      return { result: { files, count: files.length }, artifact: null, codeRevisionDigest: digest }
    }
    case 'diff': {
      const git = createGitRunner(deps.cwd)
      const args = operation.base
        ? ['diff', '--no-ext-diff', '--no-textconv', `${operation.base}...HEAD`]
        : ['diff', '--no-ext-diff', '--no-textconv', 'HEAD']
      const output = (await git(args)).toString('utf8')
      const { text, truncated } = bounded(output)
      return { result: { diff: text, truncated }, artifact: null, codeRevisionDigest: digest }
    }
    case 'pull_request': {
      if (!deps.pullRequest) throw new Error('This executor cannot read a pull request.')
      return { result: await deps.pullRequest(), artifact: null, codeRevisionDigest: digest }
    }
    case 'preview_start': {
      if (!deps.startPreview) throw new Error('This executor cannot start a preview.')
      const preview = await deps.startPreview(operation.checkId)
      return { result: { previewId: preview.previewId }, artifact: null, codeRevisionDigest: digest }
    }
    case 'preview_stop': {
      if (!deps.stopPreview) throw new Error('This executor cannot stop a preview.')
      await deps.stopPreview(operation.previewId)
      return { result: { stopped: operation.previewId }, artifact: null, codeRevisionDigest: digest }
    }
    default: {
      const preview = deps.preview(operation.previewId)
      if (!preview) throw new Error('That preview is not open for this task.')
      if (operation.kind === 'browser_snapshot')
        return { result: await preview.snapshot(), artifact: null, codeRevisionDigest: digest }
      if (operation.kind === 'browser_screenshot') {
        const bytes = await preview.screenshot()
        return {
          result: { bytes: bytes.byteLength },
          artifact: { kind: 'screenshot', name: `preview-${Date.now()}.png`, contentType: 'image/png', bytes },
          codeRevisionDigest: digest,
        }
      }
      if (operation.kind === 'browser_text') {
        const { text, truncated } = bounded(await preview.text())
        return { result: { text, truncated }, artifact: null, codeRevisionDigest: digest }
      }
      if (operation.kind === 'browser_console')
        return {
          result: { entries: await preview.console(operation.limit) },
          artifact: null,
          codeRevisionDigest: digest,
        }
      if (operation.kind === 'browser_network')
        return {
          result: { requests: await preview.network(operation.onlyErrors) },
          artifact: null,
          codeRevisionDigest: digest,
        }
      if (operation.kind === 'browser_navigate')
        return { result: await preview.navigate(operation.url), artifact: null, codeRevisionDigest: digest }
      if (operation.kind === 'browser_click') {
        await preview.click(operation.ref)
        return { result: { clicked: operation.ref }, artifact: null, codeRevisionDigest: digest }
      }
      await preview.type(operation.ref, operation.text, operation.clear)
      return { result: { typed: operation.ref, chars: operation.text.length }, artifact: null, codeRevisionDigest: digest }
    }
  }
}
