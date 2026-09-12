import { describe, expect, it, vi } from 'vitest'
import type { ChatSubscriptionUsage } from '../../src/shared/chat'
import { registerSubscriptionUsageIpc } from '../../src/main/chat/subscription-usage-ipc'

describe('subscription usage IPC', () => {
  function harness() {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const readUsage = vi.fn(async (input) => ({
      state: 'ready' as const,
      providerKind: input.providerKind,
      accountId: input.accountId ?? null,
      fetchedAt: 123,
      windows: [],
    }))
    registerSubscriptionUsageIpc({
      mhandle: (channel, handler) => handlers.set(channel, handler),
      readUsage,
      accountKind: (accountId) => (accountId === 'acc_claude' ? 'claude-subscription' : null),
    })
    const handler = handlers.get('chat:subscription-usage') as (
      event: unknown,
      payload?: unknown
    ) => Promise<ChatSubscriptionUsage>
    return { handler, readUsage }
  }

  it('passes default and validated additional accounts through the unified channel', async () => {
    const { handler, readUsage } = harness()

    await expect(handler({}, { providerKind: 'codex-subscription', force: true })).resolves.toMatchObject({
      state: 'ready',
      accountId: null,
    })
    await expect(
      handler({}, { providerKind: 'claude-subscription', accountId: ' acc_claude ' })
    ).resolves.toMatchObject({ state: 'ready', accountId: 'acc_claude' })
    expect(readUsage).toHaveBeenNthCalledWith(1, {
      providerKind: 'codex-subscription',
      accountId: null,
      force: true,
    })
    expect(readUsage).toHaveBeenNthCalledWith(2, {
      providerKind: 'claude-subscription',
      accountId: 'acc_claude',
      force: false,
    })
  })

  it('rejects an account slot that belongs to no matching provider', async () => {
    const { handler, readUsage } = harness()

    await expect(handler({}, { providerKind: 'codex-subscription', accountId: 'acc_claude' })).resolves.toEqual({
      state: 'error',
      providerKind: 'codex-subscription',
      accountId: 'acc_claude',
      error: 'unknown-account',
    })
    expect(readUsage).not.toHaveBeenCalled()
  })

  it('rejects retired and malformed providers before the adapter', async () => {
    const { handler, readUsage } = harness()

    await expect(handler({}, { providerKind: 'unsupported-provider' })).rejects.toThrow(
      'invalid-subscription-provider'
    )
    await expect(handler({}, { providerKind: 'unknown' })).rejects.toThrow('invalid-subscription-provider')
    await expect(handler({}, null)).rejects.toThrow('invalid-subscription-usage-payload')
    expect(readUsage).not.toHaveBeenCalled()
  })
})
