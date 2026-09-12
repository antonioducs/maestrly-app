import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  cwd: '' as string | undefined,
  excludeFromGitInfo: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getConversation: vi.fn(() => (h.cwd ? { cwd: h.cwd } : undefined)),
}))
vi.mock('../../src/main/git-service', () => ({ excludeFromGitInfo: h.excludeFromGitInfo }))

import { requestVSCodeNavigation } from '../../src/main/vscode/vscode-navigation'
import {
  EXT_JS,
  EXT_VERSION,
  NAVIGATION_FILE,
  OPEN_FILE_MAX_AGE_MS,
  sanitizeOpenFilePayload,
} from '../../src/main/vscode/vscode-ext-source'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-navigation-'))
  h.cwd = root
  h.excludeFromGitInfo.mockReset()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('VS Code navigation bridge', () => {
  it('writes direction and timestamp to the Git-ignored sidecar', async () => {
    await requestVSCodeNavigation('conv-1', 'back')

    const payload = JSON.parse(await fs.readFile(path.join(root, '.maestrly', NAVIGATION_FILE), 'utf8'))
    expect(payload.direction).toBe('back')
    expect(payload.ts).toEqual(expect.any(Number))
    expect(h.excludeFromGitInfo).toHaveBeenCalledWith(root, [`.maestrly/${NAVIGATION_FILE}`])
  })

  it('is a no-op when the conversation is missing', async () => {
    h.cwd = undefined

    await requestVSCodeNavigation('missing', 'forward')

    await expect(fs.access(path.join(root, '.maestrly', NAVIGATION_FILE))).rejects.toThrow()
    expect(h.excludeFromGitInfo).not.toHaveBeenCalled()
  })

  it('reseeds the extension with actual workbench commands and rejects stale sidecars', () => {
    expect(EXT_VERSION).toBe('0.0.16')
    expect(EXT_JS).toContain("'workbench.action.navigateBack'")
    expect(EXT_JS).toContain("'workbench.action.navigateForward'")
    expect(EXT_JS).toContain('Date.now() - data.ts > 5000')
    expect(() => new Function(EXT_JS)).not.toThrow()
  })

  it('opens workspace document references and preserves range selection', () => {
    expect(EXT_JS).toContain("segments.some((segment) => !segment || segment === '.' || segment === '..')")
    expect(EXT_JS).toContain('now - data.ts > 300000')
    expect(EXT_JS).toContain('vscode.workspace.getWorkspaceFolder(uri)')
    expect(EXT_JS).toContain('vscode.workspace.openTextDocument(uri)')
    expect(EXT_JS).toContain('data.endLine >= data.line')
    expect(EXT_JS).toContain('doc.lineAt(endIndex).range.end')
    expect(EXT_JS).toContain('vscode.window.showTextDocument(doc, opts)')
  })

  it('validates sidecar schema, freshness, traversal, and lines before opening', () => {
    const now = Date.now()
    expect(sanitizeOpenFilePayload({ rel: 'src/view.tsx', line: 4, endLine: 8, ts: now }, now)).toEqual({
      rel: 'src/view.tsx',
      line: 4,
      endLine: 8,
      ts: now,
    })
    expect(sanitizeOpenFilePayload({ rel: '../outside.ts', ts: now }, now)).toBeNull()
    expect(sanitizeOpenFilePayload({ rel: 'src\\outside.ts', ts: now }, now)).toBeNull()
    expect(sanitizeOpenFilePayload({ rel: '/outside.ts', ts: now }, now)).toBeNull()
    expect(sanitizeOpenFilePayload({ rel: 'src/view.tsx', ts: now - OPEN_FILE_MAX_AGE_MS - 1 }, now)).toBeNull()
    expect(sanitizeOpenFilePayload({ rel: 'src/view.tsx', line: 0, endLine: 8, ts: now }, now)).toEqual({
      rel: 'src/view.tsx',
      line: undefined,
      endLine: undefined,
      ts: now,
    })
  })
})
