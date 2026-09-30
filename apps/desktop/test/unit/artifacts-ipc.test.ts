import { describe, expect, it, vi } from 'vitest'
import { registerArtifactsIpc } from '../../src/main/artifacts/ipc'
import type { ArtifactsService } from '../../src/main/artifacts/service'
import type { IpcRegistrar } from '../../src/main/ipc-registrar'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function setup() {
  const guarded = new Map<string, Handler>()
  const unguarded: string[] = []
  const reg: IpcRegistrar = {
    handle: (channel) => void unguarded.push(channel),
    on: (channel) => void unguarded.push(channel),
    mon: (channel) => void unguarded.push(channel),
    mhandle: (channel, fn) => void guarded.set(channel, fn as Handler),
  }
  const service = {
    listAll: vi.fn(async () => []),
    detail: vi.fn(async () => null),
    remove: vi.fn(async () => ({ removed: true, freedBytes: 0 })),
    thumbnail: vi.fn(async () => null),
    openExternal: vi.fn(async () => {}),
    openInConversation: vi.fn(async () => ({})),
    status: vi.fn(async () => ({ state: 'stopped', port: 4010 })),
    start: vi.fn(async () => ({ state: 'running', port: 4010 })),
    getSettings: vi.fn(() => settings),
    setSettings: vi.fn(async (input: unknown) => input),
    sharing: vi.fn(async () => ({})),
    setSharing: vi.fn(async () => ({})),
    createInvite: vi.fn(async () => ({ principalId: person, link: 'link' })),
    inviteLink: vi.fn(async () => 'link'),
    resetInvite: vi.fn(async () => 'link'),
    revokePerson: vi.fn(async () => {}),
    revokeDevice: vi.fn(async () => {}),
    revokeAllSessions: vi.fn(async () => {}),
    decideRequest: vi.fn(async () => {}),
    events: vi.fn(async () => []),
    markSeen: vi.fn(async () => {}),
    unseenCount: vi.fn(async () => 0),
    comments: vi.fn(async () => []),
    replyComment: vi.fn(async () => ({})),
    resolveComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  }
  registerArtifactsIpc(reg, { service: () => service as unknown as ArtifactsService })
  const call = (channel: string, ...args: unknown[]) => guarded.get(channel)!({}, ...args)
  return { guarded, unguarded, service, call }
}

const id = 'A'.repeat(22)
const person = 'B'.repeat(22)
const settings = {
  hostEnabled: true,
  port: 4010,
  quotaGb: 2,
  publicAddress: '',
  ownerName: '',
  linkExpiryDays: 30,
}

describe('artifacts IPC', () => {
  it('registers every channel behind the trusted-sender guard', () => {
    const { guarded, unguarded } = setup()
    expect([...guarded.keys()].sort()).toEqual([
      'artifacts:comment-add',
      'artifacts:comment-delete',
      'artifacts:comment-resolve',
      'artifacts:comments',
      'artifacts:delete',
      'artifacts:detail',
      'artifacts:device-revoke',
      'artifacts:events',
      'artifacts:events-seen',
      'artifacts:invite-create',
      'artifacts:invite-link',
      'artifacts:invite-reset',
      'artifacts:list',
      'artifacts:open-external',
      'artifacts:open-in-conversation',
      'artifacts:person-revoke',
      'artifacts:request-decide',
      'artifacts:sessions-revoke',
      'artifacts:settings-get',
      'artifacts:settings-set',
      'artifacts:sharing-get',
      'artifacts:sharing-set',
      'artifacts:start',
      'artifacts:status',
      'artifacts:thumbnail',
      'artifacts:unseen-count',
    ])
    expect(unguarded).toEqual([])
  })

  it('validates identifiers before reaching the service', async () => {
    const { call, service } = setup()
    await expect(call('artifacts:delete', '../x')).rejects.toThrow()
    await expect(call('artifacts:detail', 42)).rejects.toThrow()
    await expect(call('artifacts:open-external', id, 0)).rejects.toThrow()
    await expect(call('artifacts:open-in-conversation', '', id)).rejects.toThrow()
    await expect(call('artifacts:thumbnail', 'nope')).rejects.toThrow()
    await expect(call('artifacts:thumbnail', id, 1.5)).rejects.toThrow()
    expect(service.remove).not.toHaveBeenCalled()
    expect(service.thumbnail).not.toHaveBeenCalled()
    expect(service.detail).not.toHaveBeenCalled()
    expect(service.openExternal).not.toHaveBeenCalled()
    expect(service.openInConversation).not.toHaveBeenCalled()

    await call('artifacts:delete', id)
    expect(service.remove).toHaveBeenCalledWith(id)
    await call('artifacts:thumbnail', id, 2)
    expect(service.thumbnail).toHaveBeenCalledWith(id, 2)
    await call('artifacts:open-in-conversation', 'conversation', id, 3)
    expect(service.openInConversation).toHaveBeenCalledWith('conversation', id, 3, {
      checkScope: false,
      activate: true,
    })
  })

  it('refuses invalid settings', async () => {
    const { call, service } = setup()
    await expect(call('artifacts:settings-set', { ...settings, port: 80 })).rejects.toThrow()
    await expect(
      call('artifacts:settings-set', { ...settings, publicAddress: 'https://x.example/path' })
    ).rejects.toThrow()
    expect(service.setSettings).not.toHaveBeenCalled()
    await call('artifacts:settings-set', { ...settings, port: 5000, publicAddress: 'https://x.example/' })
    expect(service.setSettings).toHaveBeenCalledWith({ ...settings, port: 5000, publicAddress: 'https://x.example' })
  })

  it('validates comment input before reaching the service', async () => {
    const { call, service } = setup()
    const refused: [string, ...unknown[]][] = [
      ['artifacts:comments', 'nope'],
      ['artifacts:comment-add', id, person, ''],
      ['artifacts:comment-add', id, person, '   '],
      ['artifacts:comment-add', id, person, 'x'.repeat(4001)],
      ['artifacts:comment-add', id, '../x', 'Reply'],
      ['artifacts:comment-add', 'nope', person, 'Reply'],
      ['artifacts:comment-resolve', id, person, 'yes'],
      ['artifacts:comment-resolve', id, 42, true],
      ['artifacts:comment-delete', id, ''],
      ['artifacts:comment-delete', 'nope', person],
    ]
    for (const [channel, ...args] of refused) await expect(call(channel, ...args), channel).rejects.toThrow()
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()

    await call('artifacts:comments', id)
    expect(service.comments).toHaveBeenCalledWith(id)
    await call('artifacts:comment-add', id, person, '  Thanks!  ')
    expect(service.replyComment).toHaveBeenCalledWith(id, person, 'Thanks!')
    await call('artifacts:comment-resolve', id, person, true)
    expect(service.resolveComment).toHaveBeenCalledWith(id, person, true)
    await call('artifacts:comment-resolve', id, person, false)
    expect(service.resolveComment).toHaveBeenLastCalledWith(id, person, false)
    await call('artifacts:comment-delete', id, person)
    expect(service.deleteComment).toHaveBeenCalledWith(id, person)
  })

  it('validates sharing input before reaching the service', async () => {
    const { call, service } = setup()
    const refused: [string, ...unknown[]][] = [
      ['artifacts:sharing-get', 'nope'],
      ['artifacts:sharing-set', id, { visibility: 'public' }],
      ['artifacts:sharing-set', id, { accessCode: '12345' }],
      ['artifacts:sharing-set', id, { linkExpiresAt: 'soon' }],
      ['artifacts:sharing-set', id, { visibility: 'link', extra: true }],
      ['artifacts:sharing-set', 'nope', { visibility: 'link' }],
      ['artifacts:invite-create', id, ''],
      ['artifacts:invite-create', id, '   '],
      ['artifacts:invite-create', id, 'x'.repeat(61)],
      ['artifacts:invite-create', id, 'Two\nlines'],
      ['artifacts:invite-create', 'nope', 'Maria'],
      ['artifacts:invite-link', id, '../x'],
      ['artifacts:invite-reset', id, 42],
      ['artifacts:person-revoke', id, ''],
      ['artifacts:device-revoke', id, 'x'.repeat(200)],
      ['artifacts:sessions-revoke', 'nope'],
      ['artifacts:request-decide', id, person, { approve: 'yes' }],
      ['artifacts:request-decide', id, person, { approve: true, name: '' }],
      ['artifacts:request-decide', id, 'nope', { approve: true }],
      ['artifacts:request-decide', id, person, undefined],
      ['artifacts:events', 'nope'],
      ['artifacts:events-seen', 42],
    ]
    for (const [channel, ...args] of refused) await expect(call(channel, ...args), channel).rejects.toThrow()
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()

    await call('artifacts:sharing-get', id)
    expect(service.sharing).toHaveBeenCalledWith(id)
    await call('artifacts:sharing-set', id, { visibility: 'link', accessCode: 'letmein1', linkExpiresAt: null })
    expect(service.setSharing).toHaveBeenCalledWith(id, {
      visibility: 'link',
      accessCode: 'letmein1',
      linkExpiresAt: null,
    })
    await call('artifacts:invite-create', id, '  Maria  ')
    expect(service.createInvite).toHaveBeenCalledWith(id, 'Maria')
    await call('artifacts:invite-link', id, person)
    expect(service.inviteLink).toHaveBeenCalledWith(id, person)
    await call('artifacts:invite-reset', id, person)
    expect(service.resetInvite).toHaveBeenCalledWith(id, person)
    await call('artifacts:person-revoke', id, person)
    expect(service.revokePerson).toHaveBeenCalledWith(id, person)
    await call('artifacts:device-revoke', id, person)
    expect(service.revokeDevice).toHaveBeenCalledWith(id, person)
    await call('artifacts:sessions-revoke', id)
    expect(service.revokeAllSessions).toHaveBeenCalledWith(id)
    await call('artifacts:request-decide', id, person, { approve: true, name: ' João Silva ' })
    expect(service.decideRequest).toHaveBeenCalledWith(id, person, { approve: true, name: 'João Silva' })
    await call('artifacts:request-decide', id, person, { approve: false })
    expect(service.decideRequest).toHaveBeenLastCalledWith(id, person, { approve: false })
    await call('artifacts:events')
    expect(service.events).toHaveBeenCalledWith(undefined)
    await call('artifacts:events', id)
    expect(service.events).toHaveBeenLastCalledWith(id)
    await call('artifacts:events-seen', id)
    expect(service.markSeen).toHaveBeenCalledWith(id)
    expect(await call('artifacts:unseen-count')).toBe(0)
  })
})
