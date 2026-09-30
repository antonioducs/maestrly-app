import { existsSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AntigravityAccountChangedError,
  AntigravityAuthRequiredError,
} from '../../src/main/chat/antigravity-subscription/errors'
import { antigravityTokenPath } from '../../src/main/chat/antigravity-subscription/paths'
import { createFakeAntigravity, type FakeAntigravity } from '../helpers/antigravity-fake'

let fake: FakeAntigravity
beforeEach(() => {
  fake = createFakeAntigravity()
})
afterEach(async () => {
  await fake.cleanup()
})

describe('AntigravitySubscriptionManager', () => {
  it('reports signed-out and refuses model listing before sign-in', async () => {
    const manager = fake.manager()
    expect(manager.getStatus()).toEqual({ state: 'signed-out', authenticated: false })
    expect(manager.getAccountIdentity()).toEqual({ fingerprint: null, epoch: 0 })
    await expect(manager.listModels()).rejects.toBeInstanceOf(AntigravityAuthRequiredError)
    expect(fake.runtimeStarts).toBe(0)
  })

  it('signs in through a dedicated process and exposes a project fingerprint', async () => {
    const manager = fake.manager()
    const events: string[] = []
    manager.onAuthChanged(() => events.push(manager.getStatus().state))
    const result = await manager.login()
    expect(result).toEqual({ ok: true, status: { state: 'signed-in', authenticated: true } })
    expect(result).not.toHaveProperty('authUrl')
    expect(manager.getStatus()).toEqual({ state: 'signed-in', authenticated: true })
    expect(manager.getAccountIdentity()).toMatchObject({ fingerprint: expect.stringMatching(/^project:/), epoch: 1 })
    expect(events).toEqual(['signing-in', 'signed-in'])
    expect(fake.requests('authenticate')).toEqual([expect.objectContaining({ params: { methodId: 'oauth-personal' } })])
  })

  it('lists grouped models with all built-in tools disabled and deletes the probe session', async () => {
    const manager = fake.manager()
    await manager.login()
    const models = await manager.listModels()
    expect(models.map((model) => model.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
    ])
    const [created] = fake.requests('session/new')
    expect(created?.params).toMatchObject({ mcpServers: [], _meta: { agy: { enabledTools: [] } } })
    expect((created?.params as { cwd: string }).cwd).toMatch(/[\\/]work$/)
    await expect.poll(() => fake.requests('session/delete').length).toBe(1)
    await manager.listModels()
    expect(fake.requests('session/new')).toHaveLength(1)
  })

  it('cancels a pending sign-in and kills its process', async () => {
    fake.env.FAKE_ACP_SCENARIO = 'auth-cancel'
    const manager = fake.manager()
    const pending = manager.login()
    await expect.poll(() => fake.requests('authenticate').length).toBe(1)
    expect(manager.getStatus().state).toBe('signing-in')
    manager.cancelLogin()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'Google sign-in was cancelled.' })
    expect(manager.getStatus()).toEqual({ state: 'signed-out', authenticated: false })
  })

  it('signs out by removing the account home', async () => {
    const manager = fake.manager()
    await manager.login()
    await manager.listModels()
    expect(existsSync(manager.root)).toBe(true)
    await manager.logout()
    expect(existsSync(manager.root)).toBe(false)
    expect(manager.getStatus()).toEqual({ state: 'signed-out', authenticated: false })
    expect(manager.getAccountIdentity()).toEqual({ fingerprint: null, epoch: 2 })
  })

  it('changes identity when another Google account signs in', async () => {
    const manager = fake.manager()
    await manager.login()
    const first = manager.getAccountIdentity()
    await manager.logout()
    fake.env.FAKE_ACP_PROJECT = '2'
    await manager.login()
    const second = manager.getAccountIdentity()
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(() => manager.assertAccountIdentity(first)).toThrow(AntigravityAccountChangedError)
    expect(() => manager.assertAccountIdentity(second)).not.toThrow()
  })

  it('restarts a dead process with a new generation and drops its live sessions', async () => {
    const manager = fake.manager()
    await manager.login()
    const first = await manager.connection()
    let disposed = 0
    manager.setLiveSession('c1', {
      sessionId: 's1',
      generation: first.generation,
      toolset: { dispose: () => disposed++ },
      toolSignature: 't',
      instructionHash: 'i',
      modelValue: null,
    })
    const session = await first.client.request<{ sessionId: string }>('session/new', {
      cwd: manager.workDir,
      mcpServers: [],
    })
    await first.client
      .request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'EXIT' }] })
      .catch(() => undefined)
    await first.client.exited
    await expect.poll(() => disposed).toBe(1)
    const second = await manager.connection()
    expect(second.generation).toBe(first.generation + 1)
    expect(manager.getLiveSession('c1')).toBeUndefined()
  })

  it('treats a rejected stored token as signed-out until the next sign-in', async () => {
    const manager = fake.manager()
    await manager.login()
    await manager.connection()
    rmSync(antigravityTokenPath(manager.root))
    await expect(manager.listModels(true)).rejects.toBeInstanceOf(AntigravityAuthRequiredError)
    expect(manager.getStatus()).toEqual({ state: 'signed-out', authenticated: false })
    await manager.login()
    expect(manager.getStatus().state).toBe('signed-in')
  })

  it('isolates accounts in separate homes', () => {
    const first = fake.manager({ accountId: null })
    const second = fake.manager({ accountId: 'acc_2' })
    expect(first.root).not.toBe(second.root)
    expect(second.root.endsWith('acc_2')).toBe(true)
  })
})
