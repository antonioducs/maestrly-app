import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  spawnCli: vi.fn(() => ({ unref: vi.fn() })),
  openInTerminal: vi.fn(),
  resolveCode: vi.fn(() => 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd'),
}))

vi.mock('../../src/main/platform', () => ({
  spawnCli: h.spawnCli,
  openInTerminal: h.openInTerminal,
}))

vi.mock('../../src/main/vscode/resolve-code', () => ({ resolveCode: h.resolveCode }))

import { openExternal } from '../../src/main/open-external'

let dir: string
beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(path.join(os.tmpdir(), 'open-external-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('openExternal — external editors use the cross-platform wrapper', () => {
  it('opens VS Code through spawnCli, required for code.cmd on Windows', async () => {
    await expect(openExternal(dir, 'vscode')).resolves.toEqual({ ok: true })

    expect(h.spawnCli).toHaveBeenCalledWith(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd',
      [dir],
      expect.objectContaining({ detached: true, windowsHide: true })
    )
  })
})
