/**
 * Inspections are typed. A path cannot escape the workspace, an unknown preview is refused, and a capability
 * the executor does not offer fails with a concrete reason.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  assertWorkspaceRelativePath,
  inspectionOperationSchema,
  inspectionRequiresInteraction,
} from '@maestrly/protocol'
import { runInspection, type BrowserPreview } from '../../src/main/platform/delegation-inspections'

let scratch = ''
const revision = {
  id: 'revision-1',
  baseCommit: 'a'.repeat(40),
  headCommit: 'a'.repeat(40),
  contentDigest: 'd'.repeat(64),
  snapshotArtifactId: null,
  capturedAt: '2026-09-20T00:00:00.000Z',
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'delegation-inspect-'))
  mkdirSync(path.join(scratch, 'src'))
  writeFileSync(path.join(scratch, 'src', 'feature.ts'), 'export const feature = 1\nexport const other = 2\n')
})
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

const baseDeps = () => ({
  cwd: scratch,
  revision,
  preview: () => null,
})

it('refuses any path that leaves the workspace before touching the filesystem', () => {
  expect(assertWorkspaceRelativePath('src/feature.ts')).toBe('src/feature.ts')
  expect(assertWorkspaceRelativePath('./src/./feature.ts')).toBe('src/feature.ts')
  expect(() => assertWorkspaceRelativePath('/etc/passwd')).toThrow(/relative to the workspace/)
  expect(() => assertWorkspaceRelativePath('../outside.ts')).toThrow(/inside the workspace/)
  expect(() => assertWorkspaceRelativePath('src/../../outside.ts')).toThrow(/inside the workspace/)
  expect(() => assertWorkspaceRelativePath('src/\0.ts')).toThrow(/NUL/)
})

it('reads a workspace file with bounded output and reports the revision observed', async () => {
  const outcome = await runInspection(
    inspectionOperationSchema.parse({ kind: 'read_file', path: 'src/feature.ts', offset: 0, limit: 1 }),
    baseDeps()
  )
  expect(outcome.result).toMatchObject({ path: 'src/feature.ts', lines: 1, total: 3 })
  expect(String((outcome.result as { text: string }).text)).toContain('feature = 1')
  expect(outcome.codeRevisionDigest).toBe(revision.contentDigest)

  await expect(
    runInspection(inspectionOperationSchema.parse({ kind: 'read_file', path: '../escape.ts' }), baseDeps())
  ).rejects.toThrow(/inside the workspace/)
})

it('classifies interactive operations and refuses an unknown preview', async () => {
  expect(inspectionRequiresInteraction(inspectionOperationSchema.parse({ kind: 'browser_snapshot', previewId: 'p' }))).toBe(
    false
  )
  expect(
    inspectionRequiresInteraction(
      inspectionOperationSchema.parse({ kind: 'browser_click', previewId: 'p', ref: 1 })
    )
  ).toBe(true)
  expect(
    inspectionRequiresInteraction(inspectionOperationSchema.parse({ kind: 'preview_start', checkId: 'dev' }))
  ).toBe(true)

  await expect(
    runInspection(inspectionOperationSchema.parse({ kind: 'browser_snapshot', previewId: 'ghost' }), baseDeps())
  ).rejects.toThrow(/not open for this task/)
})

it('returns a screenshot as an artifact instead of inline bytes', async () => {
  const preview: BrowserPreview = {
    previewId: 'preview-1',
    snapshot: async () => ({ elements: [] }),
    screenshot: async () => Buffer.from('png-bytes'),
    text: async () => 'visible text',
    console: async () => [{ level: 'error', text: 'boom' }],
    network: async () => [{ url: 'https://example.test', status: 500 }],
    navigate: async (url) => ({ url }),
    click: async () => {},
    type: async () => {},
  }
  const deps = { ...baseDeps(), preview: (id: string) => (id === 'preview-1' ? preview : null) }
  const shot = await runInspection(
    inspectionOperationSchema.parse({ kind: 'browser_screenshot', previewId: 'preview-1' }),
    deps
  )
  expect(shot.artifact).toMatchObject({ kind: 'screenshot', contentType: 'image/png' })
  expect(shot.artifact?.bytes.toString('utf8')).toBe('png-bytes')

  const console = await runInspection(
    inspectionOperationSchema.parse({ kind: 'browser_console', previewId: 'preview-1', limit: 10 }),
    deps
  )
  expect(console.result).toMatchObject({ entries: [{ level: 'error', text: 'boom' }] })
  const text = await runInspection(
    inspectionOperationSchema.parse({ kind: 'browser_text', previewId: 'preview-1' }),
    deps
  )
  expect(text.result).toMatchObject({ text: 'visible text', truncated: false })
})

it('fails a capability the executor does not provide instead of guessing', async () => {
  await expect(
    runInspection(inspectionOperationSchema.parse({ kind: 'search', pattern: 'feature' }), baseDeps())
  ).rejects.toThrow(/cannot search/)
  await expect(
    runInspection(inspectionOperationSchema.parse({ kind: 'glob', pattern: '**/*.ts' }), baseDeps())
  ).rejects.toThrow(/cannot list/)
  await expect(
    runInspection(inspectionOperationSchema.parse({ kind: 'pull_request' }), baseDeps())
  ).rejects.toThrow(/cannot read a pull request/)
  await expect(
    runInspection(inspectionOperationSchema.parse({ kind: 'preview_start', checkId: 'dev' }), baseDeps())
  ).rejects.toThrow(/cannot start a preview/)
})

it('uses the injected search and glob primitives when available', async () => {
  const deps = {
    ...baseDeps(),
    searchFiles: async () => [{ path: 'src/feature.ts', line: 1, text: 'export const feature = 1' }],
    listFiles: async () => ['src/feature.ts', 'README.md'],
  }
  const search = await runInspection(
    inspectionOperationSchema.parse({ kind: 'search', pattern: 'feature', limit: 5 }),
    deps
  )
  expect(search.result).toMatchObject({ count: 1 })
  const glob = await runInspection(
    inspectionOperationSchema.parse({ kind: 'glob', pattern: 'src/**/*.ts' }),
    deps
  )
  expect(glob.result).toMatchObject({ files: ['src/feature.ts'], count: 1 })
})
