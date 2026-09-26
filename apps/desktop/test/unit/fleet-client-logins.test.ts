import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import type { FleetLoginAttempt } from '@maestrly/bot-fleet-protocol'
import type { FleetClientService } from '../../src/main/fleet/client/service'
const relay = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(async () => {}) }))
vi.mock('../../src/main/fleet/client/provisioning/login-relay', () => ({ LoginRelay: { start: relay.start } }))
import {
  startBotLogin,
  botLoginStatus,
  cancelBotLogin,
  reopenBotLogin,
  disposeBotLogins,
} from '../../src/main/fleet/client/provisioning/logins'
import { setMainLocale } from '../../src/main/i18n'

function attempt(kind: 'codex' | 'claude' = 'codex'): FleetLoginAttempt {
  const port = kind === 'codex' ? 1455 : 23456
  const path = kind === 'codex' ? '/auth/callback' : '/callback'
  return {
    loginId: 'l1',
    kind,
    accountId: null,
    method: 'browser',
    state: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    browser: {
      authUrl:
        (kind === 'codex' ? 'https://auth.openai.com/authorize' : 'https://claude.ai/oauth/authorize') +
        '?redirect_uri=' +
        encodeURIComponent('http://localhost:' + port + path),
      callback: { port, path },
    },
    device: null,
    manual: kind === 'claude' ? { url: 'https://claude.ai/oauth/authorize' } : null,
    account: null,
    error: null,
  }
}
const open = vi.spyOn(shell, 'openExternal')
beforeEach(() => {
  vi.clearAllMocks()
  relay.start.mockResolvedValue({ close: relay.close })
  open.mockResolvedValue()
  setMainLocale('en')
})
afterEach(async () => {
  await disposeBotLogins()
  setMainLocale('en')
})
describe('Mac remote login flow', () => {
  it('does not restart a device login when disconnected during fallback cancellation', async () => {
    relay.start.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))
    let cancelled!: () => void
    const device = {
      ...attempt(),
      method: 'device',
      browser: null,
      device: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' },
    }
    const call = vi
      .fn()
      .mockResolvedValueOnce(attempt())
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            cancelled = resolve
          })
      )
      .mockResolvedValue(device)
    const start = startBotLogin({ call } as unknown as FleetClientService, 'bot', {
      kind: 'codex',
      method: 'browser',
      slot: 'auto',
    })
    const settled = start.then(
      () => 'opened',
      () => 'cancelled'
    )
    await vi.waitFor(() => expect(cancelled).toBeTypeOf('function'))
    await disposeBotLogins()
    cancelled()
    expect(await settled).toBe('cancelled')
    expect(call).toHaveBeenCalledTimes(2)
    expect(open).not.toHaveBeenCalled()
  })

  it('waits for gateway cancellation before starting the next Codex login', async () => {
    let cancelled!: () => void
    const call = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'botLoginCancel')
        await new Promise<void>((resolve) => {
          cancelled = resolve
        })
      return attempt()
    })
    const fleet = { call } as unknown as FleetClientService
    await startBotLogin(fleet, 'bot', { kind: 'codex', method: 'browser', slot: 'auto' })
    const next = startBotLogin(fleet, 'bot', { kind: 'codex', method: 'browser', slot: 'auto' })
    const cancel = cancelBotLogin(fleet, 'bot', 'l1')
    await vi.waitFor(() => expect(cancelled).toBeTypeOf('function'))
    const startsBeforeCancel = call.mock.calls.filter(([key]) => key === 'botLoginStart').length
    cancelled()
    await cancel
    await next
    expect(startsBeforeCancel).toBe(1)
  })

  it('disposal cancels queued and in-flight starts without opening their browser', async () => {
    let complete!: (value: FleetLoginAttempt) => void
    const call = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<FleetLoginAttempt>((resolve) => {
            complete = resolve
          })
      )
      .mockResolvedValue(undefined)
    const fleet = { call } as unknown as FleetClientService
    const first = startBotLogin(fleet, 'first', { kind: 'codex', method: 'browser', slot: 'auto' })
    const firstRejected = expect(first).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    const second = startBotLogin(fleet, 'second', { kind: 'codex', method: 'browser', slot: 'auto' })
    const secondRejected = expect(second).rejects.toThrow('cancelled')
    await disposeBotLogins()
    complete(attempt())
    await Promise.all([firstRejected, secondRejected])
    expect(open).not.toHaveBeenCalled()
    expect(relay.start).not.toHaveBeenCalled()
  })
  it('keeps a new Codex reservation while an older disposal waits for sockets to close', async () => {
    const call = vi.fn().mockResolvedValue(attempt())
    const fleet = { call } as unknown as FleetClientService
    await startBotLogin(fleet, 'old', { kind: 'codex', method: 'browser', slot: 'auto' })
    let closed!: () => void
    relay.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          closed = resolve
        })
    )
    const disposal = disposeBotLogins()
    const next = startBotLogin(fleet, 'new', { kind: 'codex', method: 'browser', slot: 'auto' })
    closed()
    await disposal
    await next
    const queued = startBotLogin(fleet, 'queued', { kind: 'codex', method: 'browser', slot: 'auto' })
    await Promise.resolve()
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(2)
    await cancelBotLogin(fleet, 'new', 'l1')
    await queued
  })
  it('opens allowed browser URL, uses UI locale, forwards callbacks and closes on terminal status', async () => {
    const value = attempt()
    const call = vi
      .fn()
      .mockResolvedValueOnce(value)
      .mockResolvedValueOnce({ status: 200, location: null, contentType: null, body: '' })
      .mockResolvedValueOnce({ ...value, state: 'completed' })
    const fleet = { call } as unknown as FleetClientService
    setMainLocale('pt-BR')
    expect(await startBotLogin(fleet, 'bot', { kind: 'codex', method: 'browser', slot: 'auto' })).toEqual({
      attempt: value,
      relay: 'listening',
    })
    expect(open).toHaveBeenCalledWith(value.browser!.authUrl)
    const options = relay.start.mock.calls[0][0]
    expect(options.page('done')).toContain('Pronto. Pode fechar esta aba')
    await options.forward('code=a')
    expect(call).toHaveBeenNthCalledWith(2, 'botLoginCallback', {
      params: { id: 'bot', lid: 'l1' },
      body: { path: '/auth/callback', query: 'code=a' },
    })
    await botLoginStatus(fleet, 'bot', 'l1')
    expect(relay.close).toHaveBeenCalledOnce()
  })
  it('cancels disallowed URLs before browser or relay access', async () => {
    const value = attempt()
    value.manual = { url: 'https://evil.example/login' }
    const call = vi.fn().mockResolvedValue(value)
    await expect(
      startBotLogin({ call } as unknown as FleetClientService, 'bot', {
        kind: 'codex',
        method: 'browser',
        slot: 'auto',
      })
    ).rejects.toThrow('not from the provider')
    expect(call).toHaveBeenLastCalledWith('botLoginCancel', { params: { id: 'bot', lid: 'l1' } })
    expect(open).not.toHaveBeenCalled()
    expect(relay.start).not.toHaveBeenCalled()
  })
  it('rejects callback metadata that differs from the authorization URL', async () => {
    const value = attempt()
    value.browser!.callback.port = 23456
    const call = vi.fn().mockResolvedValue(value)
    await expect(
      startBotLogin({ call } as unknown as FleetClientService, 'bot', {
        kind: 'codex',
        method: 'browser',
        slot: 'auto',
      })
    ).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
  it('falls back to Codex device login when the relay port is busy', async () => {
    relay.start.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))
    const value = {
      ...attempt(),
      loginId: 'device',
      method: 'device',
      browser: null,
      device: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' },
    }
    const call = vi.fn().mockResolvedValueOnce(attempt()).mockResolvedValueOnce(undefined).mockResolvedValueOnce(value)
    expect(
      await startBotLogin({ call } as unknown as FleetClientService, 'bot', {
        kind: 'codex',
        method: 'browser',
        slot: 'auto',
      })
    ).toEqual({ attempt: value, relay: 'none' })
    expect(call).toHaveBeenNthCalledWith(3, 'botLoginStart', {
      params: { id: 'bot' },
      body: { kind: 'codex', method: 'device', slot: 'auto' },
    })
    expect(open).toHaveBeenCalledWith(value.device.verificationUrl)
  })
  it('keeps the Claude paste flow when the relay port is busy', async () => {
    relay.start.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }))
    const value = attempt('claude')
    const call = vi.fn().mockResolvedValue(value)
    expect(
      await startBotLogin({ call } as unknown as FleetClientService, 'bot', {
        kind: 'claude',
        method: 'browser',
        slot: 'auto',
      })
    ).toEqual({ attempt: value, relay: 'unavailable' })
    expect(call).toHaveBeenCalledOnce()
  })
  it('serializes Codex browser starts until cancellation and validates reopened URLs', async () => {
    const value = attempt()
    const call = vi.fn().mockResolvedValue(value)
    const fleet = { call } as unknown as FleetClientService
    await startBotLogin(fleet, 'first', { kind: 'codex', method: 'browser', slot: 'auto' })
    const second = startBotLogin(fleet, 'second', { kind: 'codex', method: 'browser', slot: 'auto' })
    await Promise.resolve()
    expect(call).toHaveBeenCalledOnce()
    await cancelBotLogin(fleet, 'first', 'l1')
    await second
    value.browser!.authUrl = 'https://evil.example/'
    await expect(reopenBotLogin(fleet, 'second', 'l1', 'auth')).rejects.toThrow()
    expect(open).toHaveBeenCalledTimes(2)
  })
})
