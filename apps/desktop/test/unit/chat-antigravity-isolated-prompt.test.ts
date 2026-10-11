import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAccountChangedError } from '../../src/main/chat/antigravity-subscription/errors'
import {
  runAntigravityIsolatedPrompt,
  summarizeWithAntigravityRuntime,
} from '../../src/main/chat/antigravity-subscription/isolated-prompt'
import type { AntigravitySubscriptionManager } from '../../src/main/chat/antigravity-subscription/manager'
import { createFakeAntigravity, type FakeAntigravity } from '../helpers/antigravity-fake'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let fake: FakeAntigravity
let manager: AntigravitySubscriptionManager

beforeEach(async () => {
  fake = createFakeAntigravity()
  manager = fake.manager()
  await manager.login()
})
afterEach(() => fake.cleanup())

function args(prompt: string, overrides: Partial<Parameters<typeof runAntigravityIsolatedPrompt>[0]> = {}) {
  return {
    manager,
    accountIdentity: manager.getAccountIdentity(),
    modelId: 'gemini-3.1-pro',
    reasoningEffort: 'low',
    system: 'Summarize.',
    prompt,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function lastPrompt(): unknown[] {
  const params = fake.requests('session/prompt').at(-1)?.params as { prompt?: unknown[] } | undefined
  return params?.prompt ?? []
}

describe('Antigravity isolated prompts', () => {
  it('returns the text of a tool-less throwaway session and deletes it', async () => {
    await expect(runAntigravityIsolatedPrompt(args('history\nECHO the summary'))).resolves.toEqual({
      text: 'the summary',
    })
    const created = fake.requests('session/new').at(-1)?.params as Record<string, unknown>
    expect(created).toMatchObject({ mcpServers: [], _meta: { agy: { enabledTools: [] } } })
    expect(fake.requests('session/set_config_option').at(-1)?.params).toMatchObject({ value: 'gemini-3.1-pro-low' })
    const prompt = lastPrompt()
    expect((prompt[0] as { text?: string } | undefined)?.text).toBe(
      '<system>\nSummarize.\n</system>\n\nhistory\nECHO the summary'
    )
    await expect.poll(() => fake.requests('session/delete').length).toBeGreaterThan(0)
  })

  it('sends images as native blocks', async () => {
    await summarizeWithAntigravityRuntime(args('ECHO described', { images: [{ data: PNG, mimeType: 'image/png' }] }))
    expect(lastPrompt()[1]).toEqual({ type: 'image', mimeType: 'image/png', dataLength: PNG.length })
  })

  it('cancels the ACP turn when aborted', async () => {
    const controller = new AbortController()
    const pending = runAntigravityIsolatedPrompt(args('SLOW', { signal: controller.signal }))
    const rejected = expect(pending).rejects.toThrow('stop')
    try {
      await vi.waitFor(() => expect(fake.requests('session/prompt')).toHaveLength(1))
    } finally {
      controller.abort(new Error('stop'))
      await rejected
    }
    await expect.poll(() => fake.requests('session/cancel').length).toBe(1)
  })

  it('refuses to run for another account identity', async () => {
    await expect(
      runAntigravityIsolatedPrompt(args('ECHO x', { accountIdentity: { fingerprint: 'project:other', epoch: 1 } }))
    ).rejects.toBeInstanceOf(AntigravityAccountChangedError)
    expect(fake.requests('session/prompt')).toHaveLength(0)
  })
})
