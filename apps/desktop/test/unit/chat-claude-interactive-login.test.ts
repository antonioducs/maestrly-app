import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
vi.mock('../../src/main/window-ipc', () => ({ broadcast: vi.fn() }))
vi.mock('../../src/main/chat/claude-agent-sdk/model-catalog', () => ({
  claudeModelPickerSnapshot: () => null,
  claudeRemoteCatalogSnapshot: () => null,
  listClaudeRemoteCatalog: () => [],
  onClaudeRemoteCatalogChanged: () => () => {},
}))
import { ClaudeSubscriptionManager } from '../../src/main/chat/claude-agent-sdk/manager'

let root: string
let manager: ClaudeSubscriptionManager
let silent = false
let capture: string
const environment = vi.fn(() => ({ PATH: process.env.PATH, HOME: root }))
const children: ChildProcess[] = []
const exits: Promise<unknown>[] = []
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'claude-interactive-test-'))
  const executable = path.join(root, 'claude')
  await copyFile(path.resolve('test/fixtures/fake-claude-login.mjs'), executable)
  await chmod(executable, 0o755)
  silent = false
  manager = new ClaudeSubscriptionManager({
    resolveExecutable: () => executable,
    getUserDataPath: () => root,
    getHomeDirectory: () => root,
    getProcessEnvironment: environment,
    spawnLogin: (command, args, options) => {
      capture = path.dirname(options.env.MAESTRLY_LOGIN_URL_FILE)
      const child = spawn(command, args, {
        env: { ...options.env, FAKE_CLAUDE_SILENT: silent ? '1' : '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.push(child)
      child.stderr.resume()
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      exits.push(exited.catch(() => {}))
      return {
        stdout: child.stdout,
        stdin: child.stdin,
        exited,
        kill: () => {
          child.kill('SIGKILL')
        },
      }
    },
  })
})
afterEach(async () => {
  manager.cancelLogin()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(exits.splice(0))
  await manager.status()
  await rm(root, { recursive: true, force: true })
})
it('captures both URLs and accepts a relayed callback', async () => {
  const login = await manager.startInteractiveLogin()
  const redirect = new URL(new URL(login.autoUrl).searchParams.get('redirect_uri')!)
  expect(redirect.hostname).toBe('localhost')
  expect(redirect.pathname).toBe('/callback')
  expect(new URL(login.manualUrl).searchParams.get('redirect_uri')).toBe(
    'https://platform.claude.com/oauth/code/callback'
  )
  redirect.hostname = '127.0.0.1'
  redirect.search = '?code=good&state=fake-state'
  expect((await fetch(redirect, { redirect: 'manual' })).status).toBe(302)
  const result = await login.done
  expect(result.ok).toBe(true)
  expect(result.status.authenticated).toBe(true)
  expect(result.status.account?.email).toBe('owner@example.com')
})
it('accepts a pasted code', async () => {
  const login = await manager.startInteractiveLogin()
  login.submitCode(' good#fake-state ')
  expect((await login.done).ok).toBe(true)
})
it('rejects a wrong code', async () => {
  const login = await manager.startInteractiveLogin()
  login.submitCode('bad')
  expect((await login.done).ok).toBe(false)
})
it('cancels and removes the capture directory', async () => {
  const login = await manager.startInteractiveLogin()
  login.cancel()
  expect(await login.done).toMatchObject({ ok: false, error: 'Claude login was cancelled.' })
  await expect(access(capture)).rejects.toThrow()
})
it('kills a silent process when URLs time out', async () => {
  silent = true
  await expect(manager.startInteractiveLogin({ urlTimeoutMs: 300 })).rejects.toThrow('Claude did not start the sign-in')
  expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true)
  await expect(access(capture)).rejects.toThrow()
})
it('rejects overlapping logins and holds the mutation lock until completion', async () => {
  const login = await manager.startInteractiveLogin()
  await expect(manager.startInteractiveLogin()).rejects.toThrow('already in progress')
  expect(() => manager.createQuery({ prompt: 'test' })).toThrow('authentication is changing')
  login.cancel()
  await login.done
  expect((await manager.status()).authenticated).toBe(false)
})
it('returns the cached status without I/O', async () => {
  environment.mockClear()
  expect(manager.peekStatus()).toBeNull()
  expect(environment).not.toHaveBeenCalled()
  const status = await manager.status()
  environment.mockClear()
  expect(manager.peekStatus()).toBe(status)
  expect(environment).not.toHaveBeenCalled()
})
it('kills the process at the total deadline', async () => {
  const login = await manager.startInteractiveLogin({ totalTimeoutMs: 600 })
  expect((await login.done).ok).toBe(false)
  await expect(access(capture)).rejects.toThrow()
})

it('supports the default process spawner', async () => {
  manager = new ClaudeSubscriptionManager({
    resolveExecutable: () => path.join(root, 'claude'),
    getUserDataPath: () => root,
    getHomeDirectory: () => root,
    getProcessEnvironment: environment,
  })
  const login = await manager.startInteractiveLogin({ urlTimeoutMs: 1500, totalTimeoutMs: 2500 })
  login.submitCode('good#fake-state')
  expect((await login.done).ok).toBe(true)
})
it('can cancel a queued login and release its mutation lock', async () => {
  const pending = manager.startInteractiveLogin()
  manager.cancelLogin()
  await expect(pending).rejects.toThrow('cancelled')
  const next = await manager.startInteractiveLogin()
  next.cancel()
  await next.done
})
