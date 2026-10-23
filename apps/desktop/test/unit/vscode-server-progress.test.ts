import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test-user-data' } }))
vi.mock('../../src/main/platform', () => ({
  isWin: false,
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
// The editor server is the test's own, as in an E2E run: nothing is downloaded or spawned.
vi.mock('../../src/main/test-mode', () => ({ isE2E: () => true }))

import { getVSCodeSetupProgress, noteVSCodeSetup } from '../../src/main/vscode/setup-progress'
import { servedVSCodeCommit, startVSCodeServer, waitForEditorReady } from '../../src/main/vscode/vscode-server'

const TOKEN = 'warmup-token-1234'
const COMMIT = 'e646868227c3e3a9e3f24277c8c7220be42c0be7'
let mode: 'downloading' | 'ready' = 'downloading'
let server: http.Server

/** Answers like serve-web: the download page, then the token redirect and the workbench page behind its cookie. */
function serveWeb(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (mode === 'downloading') {
    res.writeHead(202, { 'Content-Type': 'text/html' })
    res.end('The latest version of the Visual Studio Code Server is downloading, please wait a moment...')
    return
  }
  if (req.url?.includes(`tkn=${TOKEN}`)) {
    res.writeHead(302, { Location: '/', 'Set-Cookie': `vscode-tkn=${TOKEN}` })
    res.end()
    return
  }
  if (req.headers.cookie !== `vscode-tkn=${TOKEN}`) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<!DOCTYPE html><html><head><link rel="icon" href="/stable-${COMMIT}/static/resources/server/favicon.ico">`)
}

beforeAll(async () => {
  server = http.createServer(serveWeb)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.MAESTRLY_E2E_VSCODE_SERVER = `${(server.address() as AddressInfo).port}:${TOKEN}`
  await startVSCodeServer()
})
afterAll(async () => {
  delete process.env.MAESTRLY_E2E_VSCODE_SERVER
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  mode = 'downloading'
  noteVSCodeSetup({ kind: 'reset' })
})

describe('the editor server while it sets up a version', () => {
  it('reads the version the workbench serves, and none while it downloads', async () => {
    await expect(servedVSCodeCommit()).resolves.toBeNull()
    mode = 'ready'
    await expect(servedVSCodeCommit()).resolves.toBe(COMMIT)
  })

  it('keeps waiting for a download that makes progress, and clears it once the editor answers', async () => {
    let received = 0
    const progress = setInterval(() => {
      received += 1_000_000
      noteVSCodeSetup({ kind: 'server-download', received, total: 100_000_000 })
    }, 100)
    setTimeout(() => {
      clearInterval(progress)
      mode = 'ready'
    }, 1600)
    // Without progress this would time out at the second poll, 1.2 s in.
    await expect(waitForEditorReady(300)).resolves.toBeUndefined()
    expect(getVSCodeSetupProgress().stage).toBe('idle')
  })

  it('gives up on a download without progress', async () => {
    await expect(waitForEditorReady(300)).rejects.toThrow('timed out waiting for VS Code editor')
  })
})
