import { readFile, mkdir, writeFile, chmod, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter } from '../src/providers/codex/adapter.js'
import { CodexAccount } from '../src/providers/codex/account.js'
import type { CodexAppServerClient } from '@maestrly/codex-client'
import { FixtureProvider } from '../src/providers/fixture.js'
import { RuntimeSupervisor } from '../src/runtime-supervisor.js'
import { temporary, snapshot } from './helpers.js'
import { createHash } from 'node:crypto'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function codex(untrusted = false) {
  const root = await temporary()
  const adapter = await CodexAdapter.connect({
    state: join(root, 'state'),
    workspace: join(root, 'workspace'),
    version: '0.1.0',
    binaryPath: process.execPath,
    binaryArgs: [
      fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url)),
      ...(untrusted ? ['--untrusted'] : []),
    ],
  })
  cleanups.push(() => adapter.dispose())
  return adapter
}
describe('authentication', () => {
  it('refreshes a delegated account while idle without treating it as a tool call', async () => {
    const adapter = await codex()
    const refresh = vi.fn(async () => ({ type: 'chatgptAuthTokens' as const, accessToken: 'rotated-secret-token', chatgptAccountId: 'provider-account' }))
    adapter.auth.setCredentialProvider(refresh)
    expect(await adapter.auth.useDelegated({ type: 'chatgptAuthTokens', accessToken: 'initial-secret-token', chatgptAccountId: 'provider-account' })).toMatchObject({ state: 'connected' })
    expect(await adapter.client.request('fixture/refreshAccount', {})).toMatchObject({ accepted: true, accountId: 'provider-account', token: true })
    expect(refresh).toHaveBeenCalledWith(true, createHash('sha256').update('initial-secret-token').digest('hex'))
    expect(await adapter.client.request('fixture/refreshAccount', { accountId: 'foreign-account' })).toMatchObject({ rejected: true })
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('refreshes during an active turn and preserves its account identity', async () => {
    const adapter = await codex()
    adapter.auth.setCredentialProvider(async () => ({ type: 'chatgptAuthTokens', accessToken: 'rotated-secret-token', chatgptAccountId: 'provider-account' }))
    await adapter.auth.useDelegated({ type: 'chatgptAuthTokens', accessToken: 'initial-secret-token', chatgptAccountId: 'provider-account' })
    const abort = new AbortController()
    const turn = adapter.startTurn(snapshot({ message: '#slow' }), { emit() {}, requestApproval: async () => 'deny', askQuestion: async () => '' }, abort.signal)
    expect(await adapter.client.request('fixture/refreshAccount', {})).toMatchObject({ accepted: true })
    abort.abort()
    await turn
  })
  it('exports only the private legacy credential and refuses a changed login at cutover', async () => {
    const root = await temporary(), home = join(root, 'codex')
    await mkdir(home, { mode: 0o700 })
    const file = join(home, 'auth.json')
    const client = { onNotification: () => () => {}, close: vi.fn(async () => {}) } as unknown as CodexAppServerClient
    const account = new CodexAccount(client, { home, state: root, delegated: false })
    const original = { OPENAI_API_KEY: 'private-legacy-api-key' }
    await writeFile(file, JSON.stringify(original), { mode: 0o600 })
    const exported = await account.exportLegacy()
    expect(exported.credential).toEqual(original)
    await writeFile(file, JSON.stringify({ OPENAI_API_KEY: 'different-legacy-api-key' }))
    await expect(account.commitMigration(exported.digest)).rejects.toMatchObject({ code: 'ACCOUNT_MIGRATION_CHANGED' })
    await expect(access(join(root, 'account-delegated.json'))).rejects.toBeDefined()
    expect(JSON.parse(await readFile(file, 'utf8')).OPENAI_API_KEY).toBe('different-legacy-api-key')
    await chmod(file, 0o644)
    await expect(account.exportLegacy()).rejects.toThrow('Invalid legacy credential file')
  })
  it('finishes credential removal after a restart between the migration marker and unlink', async () => {
    const root = await temporary(), home = join(root, 'codex')
    await mkdir(home, { mode: 0o700 })
    const credential = { OPENAI_API_KEY: 'private-legacy-api-key' }
    const digest = createHash('sha256').update(JSON.stringify(credential)).digest('hex')
    await writeFile(join(home, 'auth.json'), JSON.stringify(credential), { mode: 0o600 })
    await writeFile(join(root, 'account-delegated.json'), JSON.stringify({ digest }), { mode: 0o600 })
    const client = { onNotification: () => () => {}, close: vi.fn(async () => {}) } as unknown as CodexAppServerClient
    const account = new CodexAccount(client, { home, state: root, delegated: true })
    await account.commitMigration(digest)
    await expect(access(join(home, 'auth.json'))).rejects.toBeDefined()
    await account.commitMigration(digest)
    expect(client.close).not.toHaveBeenCalled()
  })
  it('does not overwrite a pending device login with an older account read', async () => {
    let finishRead!: (value: { account: null }) => void
    const client = {
      onNotification: () => () => {},
      readAccount: () => new Promise<{ account: null }>(resolve => { finishRead = resolve }),
      startAccountLogin: async () => ({ type: 'chatgptDeviceCode', loginId: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' }),
    } as unknown as CodexAppServerClient
    const account = new CodexAccount(client)
    const older = account.status()
    await account.startDevice()
    finishRead({ account: null })
    expect(await older).toMatchObject({ state: 'connecting', pending: { loginId: 'pending' } })
    account.dispose()
  })
  it('reports device pending, completion, cancellation and logout', async () => {
    const adapter = await codex()
    expect(await adapter.auth.startDevice()).toMatchObject({
      state: 'connecting',
      pending: { loginId: 'fixture-login', userCode: 'ABCD-EFGH' },
    })
    await vi.waitFor(async () =>
      expect(await adapter.auth.status()).toMatchObject({
        state: 'connected',
        account: { email: 'fixture@example.test' },
      })
    )
    await adapter.auth.logout()
    expect(await adapter.auth.status()).toMatchObject({ state: 'disconnected' })
    await adapter.auth.startDevice()
    await adapter.auth.cancel('fixture-login')
    expect(await adapter.auth.status()).toMatchObject({ state: 'disconnected' })
  })
  it('refuses an untrusted device URL', async () => {
    const adapter = await codex(true)
    expect(await adapter.auth.startDevice()).toMatchObject({ state: 'incompatible' })
  })
  it('consumes API key references once without journaling keys or device codes', async () => {
    const root = await temporary()
    const runtime = new RuntimeSupervisor({
      state: join(root, 'state'),
      workspace: join(root, 'workspace'),
      controlPath: 'unused',
      version: '0.1.0',
      providerFactory: async () => new FixtureProvider(join(root, 'workspace')),
    })
    await runtime.initialize()
    cleanups.push(() => runtime.close())
    const handlers = runtime.handlers()
    const key = 'sk-secret-never-journal'
    await handlers['auth.secret']({ secretRef: 'ref', apiKey: key })
    expect(await handlers['auth.start']({ method: 'apiKey', secretRef: 'ref' })).toMatchObject({
      state: 'connected',
      method: 'apiKey',
    })
    await expect(handlers['auth.start']({ method: 'apiKey', secretRef: 'ref' })).rejects.toThrow()
    runtime.journal.nextGeneration()
    const contents = await readFile(runtime.journal.path, 'utf8')
    expect(contents).not.toContain(key)
    expect(contents).not.toContain('ABCD-EFGH')
  })
  it('maps real API key login', async () => {
    const adapter = await codex()
    expect(await adapter.auth.startApiKey('sk-fixture-secret')).toMatchObject({ state: 'connected', method: 'apiKey' })
  })
})

it('restarts the provider with backoff after its process exits', async () => {
  const root = await temporary()
  let exit!: () => void
  const exited = new Promise<void>((resolve) => {
    exit = resolve
  })
  const first = Object.assign(new FixtureProvider(join(root, 'workspace')), { waitForExit: () => exited })
  const second = new FixtureProvider(join(root, 'workspace'))
  const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second)
  const runtime = new RuntimeSupervisor({
    state: join(root, 'state'),
    workspace: join(root, 'workspace'),
    controlPath: 'unused',
    version: '0.1.0',
    providerFactory: factory,
  })
  await runtime.initialize()
  cleanups.push(() => runtime.close())
  exit()
  await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2), { timeout: 3000 })
  expect(await runtime.handlers()['runtime.inspect']({})).toMatchObject({ state: 'ready' })
})

it('enables an ephemeral account store only when no previous credential needs migration', async () => {
  const root = await temporary(), home = join(root, 'codex')
  await mkdir(home, { mode: 0o700 })
  const close = vi.fn(async () => {})
  const client = { onNotification: () => () => {}, close } as unknown as CodexAppServerClient
  const empty = new CodexAccount(client, { state: root, home, delegated: false })
  await empty.prepareDelegation()
  expect(close).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await readFile(join(root, 'account-delegated.json'), 'utf8')).digest).toMatch(/^[a-f0-9]{64}$/)
  const other = await temporary(), otherHome = join(other, 'codex')
  await mkdir(otherHome, { mode: 0o700 })
  await writeFile(join(otherHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'preserve-this-existing-key' }), { mode: 0o600 })
  const connected = new CodexAccount(client, { state: other, home: otherHome, delegated: false })
  await expect(connected.prepareDelegation()).rejects.toMatchObject({ code: 'ACCOUNT_MIGRATION_REQUIRED' })
  expect(await readFile(join(otherHome, 'auth.json'), 'utf8')).toContain('preserve-this-existing-key')
})
