import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { pathEnvKey, refreshWindowsPathFromRegistry, windowsEnvValue } from '../../src/main/fix-path'
import { refreshGitPath, windowsGitDirectories } from '../../src/main/git-command'
import { PluginGitSource } from '../../src/main/plugins/git-source'

const execFileAsync = promisify(execFile)
const onWindows = process.platform === 'win32'
const installedGitDir = onWindows
  ? windowsGitDirectories().find((dir) => existsSync(path.win32.join(dir, 'git.exe')))
  : undefined

/** A copy of this process's environment whose PATH holds only System32, as before a tool was installed. */
function staleEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const systemRoot = windowsEnvValue(env, 'SystemRoot') ?? 'C:\\Windows'
  env[pathEnvKey(env)] = path.win32.join(systemRoot, 'System32')
  return env
}

describe.runIf(onWindows)('Windows PATH refresh against the real system', () => {
  it('rereads the machine and user Path from the registry with reg.exe', async () => {
    const env = staleEnvironment()
    const before = env[pathEnvKey(env)]
    const added = await refreshWindowsPathFromRegistry({ env })
    // The machine Path always names more than System32 (for example the Windows directory itself).
    expect(added.length).toBeGreaterThan(0)
    for (const dir of added) expect(existsSync(dir)).toBe(true)
    expect(env[pathEnvKey(env)]).toBe([before, ...added].join(';'))
  })

  it.runIf(installedGitDir !== undefined)('makes an installed Git spawnable from a PATH that lacked it', async () => {
    const env = staleEnvironment()
    await expect(execFileAsync('git', ['--version'], { env, windowsHide: true })).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const found = await refreshGitPath({ env, readKey: async () => null })
    const context = JSON.stringify({
      installedGitDir,
      candidates: windowsGitDirectories(env),
      path: env[pathEnvKey(env)],
      keys: Object.keys(env).filter((key) => /^(path|programfiles|localappdata)/i.test(key)),
    })
    expect(found, context).toBe(true)
    expect(env[pathEnvKey(env)]?.split(';')).toContain(installedGitDir)
    const { stdout } = await execFileAsync('git', ['--version'], { env, windowsHide: true })
    expect(stdout).toMatch(/^git version \d+\.\d+/)
  })

  it.runIf(installedGitDir !== undefined)('lets plugin downloads reach Git from a PATH that lacked it', async () => {
    // The plugin runner builds its restricted environment from this process's own, so that is what goes stale.
    const key = pathEnvKey(process.env)
    const saved = process.env[key]
    const stale = staleEnvironment()
    process.env[key] = stale[pathEnvKey(stale)]
    try {
      await expect(new PluginGitSource({ allowFileRoot: null }).gitVersion()).resolves.toMatch(/^\d+\.\d+/)
    } finally {
      process.env[key] = saved
    }
  })
})
