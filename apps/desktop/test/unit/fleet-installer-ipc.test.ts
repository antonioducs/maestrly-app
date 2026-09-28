import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'
import { registerFleetInstallerIpc } from '../../src/main/fleet/installer/ipc'

afterEach(() => {
  delete process.env.MAESTRLY_BOT_MODE
})

function register() {
  const reads = new Map<string, (...args: unknown[]) => unknown>()
  const mutations = new Map<string, (...args: unknown[]) => unknown>()
  const service = {
    status: vi.fn(() => 'status'),
    checkLocal: vi.fn(async () => 'check'),
    installLocal: vi.fn(async () => 'local'),
    installRemote: vi.fn(async () => 'remote'),
    update: vi.fn(async () => 'update'),
    setPrivateNetwork: vi.fn(async () => 'private'),
    disconnect: vi.fn(async () => 'disconnect'),
    remove: vi.fn(async () => 'remove'),
    cancel: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  registerFleetInstallerIpc(
    {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => reads.set(channel, fn),
      mhandle: (channel: string, fn: (...args: unknown[]) => unknown) => mutations.set(channel, fn),
    } as unknown as IpcRegistrar,
    service as never
  )
  const mutate = (channel: string, ...args: unknown[]) => mutations.get(channel)!({}, ...args)
  return { reads, mutations, service, mutate }
}

const remote = {
  target: { host: '203.0.113.10', port: 22, username: 'root' },
  credentials: { kind: 'password', password: 'synthetic-root-password' },
  deviceName: 'Mac',
  allowPrivateNetwork: false,
}

describe('bot server installer IPC', () => {
  it('reads status and Docker without a trusted sender, and changes nothing through a read channel', () => {
    const { reads, mutations } = register()
    expect([...reads.keys()].sort()).toEqual(['fleet:installer:checkLocal', 'fleet:installer:status'])
    expect([...mutations.keys()].sort()).toEqual(
      [
        'fleet:installer:cancel',
        'fleet:installer:disconnect',
        'fleet:installer:installLocal',
        'fleet:installer:installRemote',
        'fleet:installer:remove',
        'fleet:installer:setPrivateNetwork',
        'fleet:installer:update',
      ].sort()
    )
  })

  it('rejects malformed input before the service sees it', () => {
    const { mutate, service } = register()
    const invalid: Array<[string, unknown]> = [
      ['fleet:installer:installLocal', { deviceName: '', allowPrivateNetwork: false }],
      ['fleet:installer:installLocal', { deviceName: 'Mac', allowPrivateNetwork: 'yes' }],
      ['fleet:installer:installLocal', { deviceName: 'Mac', allowPrivateNetwork: false, extra: 1 }],
      ['fleet:installer:installRemote', { ...remote, target: { ...remote.target, host: 'my server' } }],
      ['fleet:installer:installRemote', { ...remote, target: { ...remote.target, host: 'a;rm -rf' } }],
      ['fleet:installer:installRemote', { ...remote, target: { ...remote.target, port: 0 } }],
      ['fleet:installer:installRemote', { ...remote, target: { ...remote.target, username: 'root;id' } }],
      ['fleet:installer:installRemote', { ...remote, credentials: { kind: 'password', password: 'x'.repeat(1025) } }],
      ['fleet:installer:installRemote', { ...remote, credentials: { password: 'synthetic' } }],
      [
        'fleet:installer:installRemote',
        { ...remote, credentials: { kind: 'key', privateKey: 'x'.repeat(16385), passphrase: null } },
      ],
      ['fleet:installer:setPrivateNetwork', 'yes'],
      ['fleet:installer:remove', { confirm: 'delete' }],
      ['fleet:installer:remove', undefined],
    ]
    for (const [channel, input] of invalid)
      expect(() => mutate(channel, input), `${channel} ${JSON.stringify(input)}`).toThrow()
    for (const method of ['installLocal', 'installRemote', 'setPrivateNetwork', 'remove'] as const)
      expect(service[method]).not.toHaveBeenCalled()
  })

  it('passes valid input on', async () => {
    const { mutate, service } = register()
    await mutate('fleet:installer:installLocal', { deviceName: ' Mac ', allowPrivateNetwork: true })
    expect(service.installLocal).toHaveBeenCalledWith({ deviceName: 'Mac', allowPrivateNetwork: true })
    for (const host of ['vps.example.test', '[2001:db8::1]', '2001:db8::1'])
      await mutate('fleet:installer:installRemote', { ...remote, target: { ...remote.target, host } })
    await mutate('fleet:installer:installRemote', {
      ...remote,
      credentials: { kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic', passphrase: null },
    })
    expect(service.installRemote).toHaveBeenCalledTimes(4)
    await mutate('fleet:installer:setPrivateNetwork', false)
    expect(service.setPrivateNetwork).toHaveBeenCalledWith(false)
    await mutate('fleet:installer:remove', { confirm: 'remove' })
    expect(service.remove).toHaveBeenCalledTimes(1)
  })

  it('opens the VPS tunnel with the app, except in a bot’s own Maestrly', () => {
    expect(register().service.start).toHaveBeenCalledTimes(1)
    process.env.MAESTRLY_BOT_MODE = '1'
    expect(register().service.start).not.toHaveBeenCalled()
  })
})
