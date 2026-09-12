import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CopilotClient, defineTool, RuntimeConnection, type SessionConfig } from '@github/copilot-sdk'
import { describe, expect, it } from 'vitest'
import {
  resolveGithubCopilotRuntime,
  type GithubCopilotRuntimeResolution,
} from '../../src/main/chat/github-copilot/runtime-resolver'

/**
 * Smoke test for the real official runtime. Postinstall normally installs the host package.
 * Skip when optional dependencies or network access were omitted to support offline test runs.
 * Packaging continues to fail closed during fetch and afterPack.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const runtime = (() => {
  try {
    const result = resolveGithubCopilotRuntime({
      isPackaged: false,
      resourcesPath: path.join(root, 'resources'),
      appPath: root,
    })
    return result.source === 'path' ? null : result
  } catch {
    return null
  }
})() as GithubCopilotRuntimeResolution | null

describe('GitHub Copilot SDK tool-search contract', () => {
  it('accepts selective deferral and toolSearch in the pinned SDK', () => {
    const deferred = defineTool('drawer_tool', {
      description: 'Deferred drawer tool',
      parameters: { type: 'object', properties: {} },
      defer: 'auto',
      handler: async () => 'ok',
    })
    const eager = defineTool('read', {
      description: 'Eager bridge',
      parameters: { type: 'object', properties: {} },
      defer: 'never',
      handler: async () => 'ok',
    })
    const config = {
      tools: [deferred, eager],
      availableTools: ['custom:drawer_tool', 'custom:read'],
      toolSearch: { enabled: true, deferThreshold: 0 },
    } satisfies SessionConfig

    expect(config.toolSearch).toEqual({ enabled: true, deferThreshold: 0 })
    expect(config.tools.map((entry) => entry.defer)).toEqual(['auto', 'never'])
  })
})

describe.skipIf(!runtime)('official GitHub Copilot runtime', () => {
  it('reports the pinned version through the running native SDK server', async () => {
    const copilotHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly-copilot-version-'))
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: runtime!.executablePath }),
      mode: 'empty',
      baseDirectory: copilotHome,
      useLoggedInUser: false,
      logLevel: 'error',
    })
    try {
      await client.start()
      expect((await client.getStatus()).version).toMatch(/^1\.0\.71(?:[.+-]|$)/)
    } finally {
      await client.stop()
      rmSync(copilotHome, { recursive: true, force: true })
    }
  }, 90_000)

  it('completes the SDK stdio handshake without automatic login', async () => {
    const copilotHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly-github-copilot-runtime-smoke-'))
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: runtime!.executablePath }),
      mode: 'empty',
      baseDirectory: copilotHome,
      useLoggedInUser: false,
      logLevel: 'error',
    })

    try {
      await client.start()
      await expect(client.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: false })
    } finally {
      await client.stop()
      rmSync(copilotHome, { recursive: true, force: true })
    }
  }, 90_000)
})
