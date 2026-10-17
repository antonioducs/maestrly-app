import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AntigravityAccountChangedError,
  AntigravityAuthRequiredError,
} from '../../src/main/chat/antigravity-subscription/errors'
import type { AntigravityHostToolset } from '../../src/main/chat/antigravity-subscription/host-mcp'
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

  it('lists grouped models from one probe session with all built-in tools disabled', async () => {
    const manager = fake.manager()
    await manager.login()
    const models = await manager.listModels()
    expect(models.map((model) => model.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
    ])
    const created = fake.requests('session/new')[0]?.params as { cwd: string } | undefined
    expect(created).toMatchObject({ mcpServers: [], _meta: { agy: { enabledTools: [] } } })
    expect(created?.cwd).toMatch(/[\\/]work$/)
    await manager.listModels()
    await manager.listModels(true)
    expect(fake.requests('session/new')).toHaveLength(1)
  })

  it('shares one probe session between concurrent catalog requests', async () => {
    const manager = fake.manager()
    await manager.login()
    const signInStarts = fake.runtimeStarts
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => manager.listModels(index % 3 === 0)))
    expect(new Set(results.map((entries) => entries.map((entry) => entry.id).join(','))).size).toBe(1)
    expect(fake.requests('session/new')).toHaveLength(1)
    expect(fake.runtimeStarts - signInStarts).toBe(1)
  })

  it('keeps a running process catalog and lets only an older forced refresh probe again', async () => {
    let now = 1_000_000
    const manager = fake.manager({ now: () => now })
    await manager.login()
    await manager.listModels()
    now += 30 * 60_000
    await manager.listModels()
    expect(fake.requests('session/new')).toHaveLength(1)
    await Promise.all([manager.listModels(true), manager.listModels(true), manager.listModels()])
    expect(fake.requests('session/new')).toHaveLength(2)
    now += 9 * 60_000
    await manager.listModels(true)
    expect(fake.requests('session/new')).toHaveLength(2)
  })

  it('answers from the catalog without restarting a closed process, then removes the probe files', async () => {
    let now = 1_000_000
    const manager = fake.manager({ now: () => now })
    await manager.login()
    const signInStarts = fake.runtimeStarts
    await manager.listModels()
    const conversations = path.join(manager.root, '.gemini', 'antigravity-acp', 'conversations')
    expect(readdirSync(conversations).filter((name) => name.endsWith('.meta'))).toHaveLength(1)
    await manager.closeSessions()
    await expect.poll(() => readdirSync(conversations).filter((name) => name.endsWith('.meta'))).toHaveLength(0)
    await manager.listModels()
    expect(fake.runtimeStarts - signInStarts).toBe(1)
    now += 11 * 60_000
    await manager.listModels()
    expect(fake.runtimeStarts - signInStarts).toBe(2)
    expect(fake.requests('session/new')).toHaveLength(2)
  })

  it('reports the subscription tier from sign-in and keeps it for the next start', async () => {
    fake.env.FAKE_ACP_TIER = 'Google AI Pro'
    const manager = fake.manager()
    await manager.login()
    expect(manager.getStatus()).toEqual({ state: 'signed-in', authenticated: true, planType: 'Google AI Pro' })
    const restarted = fake.manager()
    expect(restarted.getStatus()).toMatchObject({ planType: 'Google AI Pro' })
    expect(fake.runtimeStarts).toBe(1)
    await manager.logout()
    expect(manager.getStatus()).toEqual({ state: 'signed-out', authenticated: false })
  })

  it('learns the tier from the probe session and notifies the account card', async () => {
    const manager = fake.manager()
    await manager.login()
    expect(manager.getStatus()).not.toHaveProperty('planType')
    const events: Array<string | null | undefined> = []
    manager.onAuthChanged(() => events.push(manager.getStatus().planType))
    fake.env.FAKE_ACP_TIER = 'Google AI Ultra'
    await manager.listModels()
    expect(manager.getStatus()).toMatchObject({ planType: 'Google AI Ultra' })
    expect(events).toEqual(['Google AI Ultra'])
  })

  it('reads quota windows through /usage on the probe session', async () => {
    fake.env.FAKE_ACP_USAGE = '1'
    let now = 1_000_000
    const manager = fake.manager({ now: () => now })
    await manager.login()
    await manager.listModels()
    const [windows, again] = await Promise.all([manager.readUsage(), manager.readUsage()])
    expect(windows).toEqual([
      {
        id: 'gemini-models-weekly-limit',
        kind: 'weekly-model',
        usedPercent: 9,
        resetsAt: Date.UTC(2026, 9, 2, 8, 22),
        durationMins: 10_080,
        label: 'Gemini Models',
      },
      {
        id: 'claude-and-gpt-models-weekly-limit',
        kind: 'weekly-model',
        usedPercent: 0,
        resetsAt: null,
        durationMins: 10_080,
        label: 'Claude and GPT models',
      },
    ])
    expect(again).toBe(windows)
    const prompts = fake.requests('session/prompt')
    expect(prompts).toHaveLength(1)
    const probe = fake.requests('session/new')
    expect(probe).toHaveLength(1)
    expect(prompts[0]?.params).toMatchObject({ prompt: [{ type: 'text', text: '/usage' }] })
    await manager.readUsage()
    now += 2 * 60_000
    await manager.readUsage()
    await manager.readUsage(true)
    expect(fake.requests('session/prompt')).toHaveLength(3)
    expect(fake.requests('session/new')).toHaveLength(1)
  })

  it('never sends /usage to a runtime that does not advertise it', async () => {
    const manager = fake.manager()
    await manager.login()
    await expect(manager.readUsage()).resolves.toBeNull()
    expect(fake.requests('session/prompt')).toHaveLength(0)
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
      toolset: { dispose: () => disposed++ } as unknown as AntigravityHostToolset,
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

it.skipIf(process.platform === 'win32')(
  'captures the remote browser URL and closes the dedicated agent on cancellation',
  async () => {
    fake.env.FAKE_ACP_SCENARIO = 'auth-browser'
    const manager = fake.manager()
    const urls: string[] = []
    const controller = new AbortController()
    const pending = manager.login(controller.signal, (url) => urls.push(url))
    await expect.poll(() => urls.length).toBe(1)
    expect(urls[0]).toBe('https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A32123%2F')
    expect(fake.requests('authenticate')[0]).toMatchObject({ params: { methodId: 'oauth-personal' } })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'Google sign-in was cancelled.' })
    expect(manager.getStatus().state).toBe('signed-out')
  }
)
