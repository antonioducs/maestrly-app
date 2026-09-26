import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import { CodexSubscriptionManager } from '../../src/main/chat/codex-subscription/manager'

describe('Codex login methods', () => {
  let manager: CodexSubscriptionManager
  const startAccountLogin = vi.fn()
  const request = vi.fn(async () => ({}))
  beforeEach(() => {
    startAccountLogin.mockReset()
    request.mockClear()
    manager = new CodexSubscriptionManager()
    const client = {
      startAccountLogin,
      cancelAccountLogin: CodexAppServerClient.prototype.cancelAccountLogin,
      request,
      readAccount: vi.fn(async () => ({ account: null, requiresOpenaiAuth: true })),
    } as unknown as CodexAppServerClient
    vi.spyOn(manager, 'getClient').mockResolvedValue(client)
  })
  afterEach(async () => {
    await manager.dispose()
  })

  it('starts a device code login', async () => {
    startAccountLogin.mockResolvedValue({
      type: 'chatgptDeviceCode',
      loginId: 'l1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    await expect(manager.startLogin({ method: 'device' })).resolves.toMatchObject({
      loginId: 'l1',
      method: 'device',
      authUrl: null,
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    expect(startAccountLogin).toHaveBeenCalledWith({ type: 'chatgptDeviceCode' })
  })
  it('preserves browser login by default', async () => {
    startAccountLogin.mockResolvedValue({ type: 'chatgpt', loginId: 'l1', authUrl: 'https://auth.openai.com/login' })
    await expect(manager.startLogin()).resolves.toMatchObject({
      method: 'browser',
      authUrl: 'https://auth.openai.com/login',
      verificationUrl: null,
      userCode: null,
    })
    expect(startAccountLogin).toHaveBeenCalledWith({
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    })
  })
  it('cancels the runtime login and settles pending waiters', async () => {
    startAccountLogin.mockResolvedValue({ type: 'chatgpt', loginId: 'l1', authUrl: 'https://auth.openai.com/login' })
    await manager.startLogin()
    const completion = manager.waitForLogin('l1')
    await manager.cancelLogin('l1')
    expect(request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'l1' }, undefined)
    await expect(completion).resolves.toMatchObject({ success: false, error: expect.stringContaining('cancelled') })
    expect(manager.getLoginStatus('l1')?.state).toBe('failed')
  })
  it('ignores unknown attempts without connecting', async () => {
    await manager.cancelLogin('unknown')
    expect(request).not.toHaveBeenCalled()
    expect(manager.getClient).not.toHaveBeenCalled()
  })
  it('peeks at cached status without I/O', async () => {
    expect(manager.peekStatus()).toBeNull()
    expect(manager.getClient).not.toHaveBeenCalled()
    const status = await manager.getStatus()
    expect(manager.peekStatus()).toBe(status)
  })
  it('rejects a mismatched device response', async () => {
    startAccountLogin.mockResolvedValue({ type: 'chatgpt', loginId: 'l1', authUrl: 'https://auth.openai.com/login' })
    await expect(manager.startLogin({ method: 'device' })).rejects.toThrow('Expected')
  })
})
