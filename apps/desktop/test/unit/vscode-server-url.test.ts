import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Covers getVSCodeUrl ?folder= on Windows. The web workbench treats only values beginning with /
 * as remote paths; URI.parse otherwise reads the drive prefix as a scheme and corrupts the workspace.
 * Normalize Windows paths to /C:/Users/... using forward slashes and a leading slash, idempotently:
 * reloadAllVSCode extracts the normalized folder and passes it through the same builder again.
 * isWin is read at import time, so each case resets modules and imports dynamically.
 */

const h = vi.hoisted(() => ({ isWin: false }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test-user-data' } }))
vi.mock('../../src/main/platform', () => ({
  get isWin() {
    return h.isWin
  },
  isLinux: false,
  vscodeUserDir: () => '/tmp/vscode-user',
  vscodeExtDir: () => '/tmp/vscode-ext',
  killProcessTree: vi.fn(),
  spawnCli: vi.fn(),
}))
vi.mock('../../src/main/vscode/vscode-cli-download', () => ({
  ensureVSCodeCli: vi.fn(),
  applyStagedCliUpdate: vi.fn(),
}))
vi.mock('../../src/main/net-port', () => ({ findFreePort: vi.fn() }))
vi.mock('../../src/main/secret-file', () => ({ chmod0600: vi.fn() }))
vi.mock('../../src/main/crash-reporter', () => ({ captureProcessExit: vi.fn() }))

async function freshServer() {
  vi.resetModules()
  return import('../../src/main/vscode/vscode-server')
}

function folderParam(url: string): string | null {
  return new URL(url).searchParams.get('folder')
}

beforeEach(() => {
  h.isWin = false
})

describe('getVSCodeUrl — ?folder= format', () => {
  it('POSIX: absolute paths pass through unchanged', async () => {
    const s = await freshServer()
    expect(folderParam(s.getVSCodeUrl('/Users/example/proj'))).toBe('/Users/example/proj')
  })

  it('Windows: C:\\Users\\... becomes /C:/Users/... (remote URI path)', async () => {
    h.isWin = true
    const s = await freshServer()
    expect(folderParam(s.getVSCodeUrl('C:\\Users\\example\\sample-project'))).toBe('/C:/Users/example/sample-project')
  })

  it('Windows: normalization is idempotent without adding another slash', async () => {
    h.isWin = true
    const s = await freshServer()
    expect(folderParam(s.getVSCodeUrl('/C:/Users/example/sample-project'))).toBe('/C:/Users/example/sample-project')
  })

  it('no folder → no parameter', async () => {
    const s = await freshServer()
    expect(folderParam(s.getVSCodeUrl(''))).toBeNull()
  })
})
