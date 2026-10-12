import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerRemoteUiTarget } from '../../src/main/remote-ui-targets'
import { stopSelectionBridge, watchConversation } from '../../src/main/selection-bridge'

const roots: string[] = []
afterEach(async () => {
  stopSelectionBridge()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('selections of the editor', () => {
  it("reach the composer of a computer that shows a workspaces host's conversation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'selection-remote-'))
    roots.push(cwd)
    const remote = { id: -1000, send: vi.fn(), isDestroyed: () => false }
    const unregister = registerRemoteUiTarget(remote, { role: 'main' })
    try {
      await watchConversation('conv-1', cwd)
      await writeFile(
        path.join(cwd, '.maestrly', 'agent-selection.json'),
        JSON.stringify({
          kind: 'selection',
          path: path.join(cwd, 'src', 'a.ts'),
          scheme: 'vscode-remote',
          startLine: 2,
          endLine: 4,
          ts: Date.now(),
        })
      )
      await vi.waitFor(
        () =>
          expect(remote.send).toHaveBeenCalledWith('chat:reference:conv-1', {
            path: path.join('src', 'a.ts'),
            startLine: 2,
            endLine: 4,
          }),
        { timeout: 5_000 }
      )
    } finally {
      unregister()
    }
  })
})
