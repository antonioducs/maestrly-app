import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ChatGPT runs only user-allowlisted checks selected by name;
 * the model never supplies command lines. This is the permitted bridge side effect.
 */
const settings = new Map<string, string>()
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => settings.set(key, value),
}))

const { getChecksConfig, listChecks, runCheck, setChecksConfig } = await import(
  '../../src/main/chat/chatgpt-web/checks'
)

let repo: string

beforeEach(() => {
  settings.clear()
  repo = mkdtempSync(path.join(os.tmpdir(), 'chatweb-checks-'))
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('check command allowlist', () => {
  it('does not discover package scripts without configuration', () => {
    writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest run', lint: 'biome lint .', typecheck: 'tsc', dev: 'vite', publish: 'npm publish' },
      })
    )
    expect(listChecks(repo)).toEqual([])
  })

  it('offers no checks without package manifests', () => {
    expect(listChecks(repo)).toEqual([])
  })

  it('builds shell-free commands from explicit user configuration', () => {
    setChecksConfig('# comment\npytest = pytest -q tests\n\nlint = ruff check .')
    expect(getChecksConfig()).toContain('pytest')
    const checks = listChecks(repo)
    expect(checks.map((check) => check.name)).toEqual(['pytest', 'lint'])
    expect(checks[0].command).toEqual(['pytest', '-q', 'tests'])
  })

  it('ignores malformed configuration lines', () => {
    setChecksConfig('without-equals\n= without name\nok = echo hi')
    expect(listChecks(repo).map((check) => check.name)).toEqual(['ok'])
  })

  it('returns check output and exit codes', async () => {
    setChecksConfig('ok = node -e console.log("check-output")')
    const result = await runCheck(repo, 'ok')
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('check-output')
  })

  it('propagates failed exit codes for review evidence', async () => {
    setChecksConfig('failure = node -e process.exit(3)')
    const result = await runCheck(repo, 'failure')
    expect(result.exitCode).toBe(3)
  })

  it('returns structured failures for missing executables', async () => {
    setChecksConfig('broken = maestrly-missing-executable --version')
    const result = await runCheck(repo, 'broken')
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('Failed to start')
  })

  it('cancels process trees when turns end', async () => {
    setChecksConfig('lento = node -e setInterval(()=>{},1000)')
    const controller = new AbortController()
    const pending = runCheck(repo, 'lento', controller.signal)
    controller.abort()
    const result = await pending
    expect(result.exitCode).toBeNull()
    expect(result.aborted).toBe(true)
    expect(result.output).toContain('cancelled')
  })

  it('does not execute names outside the allowlist', async () => {
    setChecksConfig('ok = node -e console.log(1)')
    const result = await runCheck(repo, 'rm')
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('Unknown')
  })
})
