import { describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../src/gateway/client'
import {
  loadPushPreferences,
  pushLink,
  pushTarget,
  registerWithServers,
  savePushPreferences,
} from '../src/notifications/push'
import { memoryStores, type PairedServer } from '../src/servers/registry'

const server = (id: string, features: string[] = ['phones']): PairedServer => ({
  id,
  origin: `https://${id}.example.dev`,
  name: id,
  deviceName: 'iPhone',
  features,
  pairedAt: '2026-10-13T12:00:00.000Z',
})
const preferences = { waiting: true, replies: false, routines: true, errors: true }

describe('notifications', () => {
  it('keeps what the phone wants to hear about, every kind by default', async () => {
    const { kv } = memoryStores()
    expect(await loadPushPreferences(kv)).toEqual({ waiting: true, replies: true, routines: true, errors: true })
    await savePushPreferences(kv, preferences)
    expect(await loadPushPreferences(kv)).toEqual(preferences)
    await kv.set('prefs.notifications', '{"waiting":"yes"}')
    expect((await loadPushPreferences(kv)).waiting).toBe(true)
  })

  it('opens what a notification is about on the server that sent it, by the device id it knows the phone by', () => {
    const servers = [server('d1'), server('d2')]
    const target = pushTarget({ v: 1, device: 'd2', kind: 'chat', id: 'c 1', category: 'waiting' }, servers)
    expect(target).toEqual({ serverId: 'd2', kind: 'chat', id: 'c 1' })
    expect(pushLink(target!)).toBe('/chat/c%201?server=d2')
    expect(pushTarget({ v: 1, device: 'unknown', kind: 'bot', id: 'atlas', category: null }, servers)).toBeNull()
    expect(pushTarget({ v: 1, device: 'd1', kind: 'test', id: null, category: null }, servers)).toBeNull()
    expect(pushTarget({ text: 'hello' }, servers)).toBeNull()
  })

  it('registers with each server that sends notifications, and says why one does not', async () => {
    const calls: Array<[string, unknown]> = []
    const client = (answer: () => unknown) => ({
      call: vi.fn(async (key: string, options: unknown) => {
        calls.push([key, options])
        return answer()
      }),
    })
    const results = await registerWithServers({
      servers: [server('a'), server('old', []), server('off'), server('down'), server('demo')],
      token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      platform: 'ios',
      locale: 'pt-BR',
      preferences,
      skip: (item) => item.id === 'demo',
      clientFor: async (item) =>
        item.id === 'off'
          ? (client(() => {
              throw new GatewayError('CONFLICT', 409, 'off')
            }) as never)
          : item.id === 'down'
            ? null
            : (client(() => ({})) as never),
    })
    expect(results).toEqual({ a: 'registered', old: 'unsupported', off: 'off', down: 'failed' })
    expect(calls[0]).toEqual([
      'devicePushSet',
      {
        body: {
          provider: 'expo',
          token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
          platform: 'ios',
          locale: 'pt-BR',
          preferences,
        },
      },
    ])
  })
})
