import { describe, expect, it } from 'vitest'
import { chatOutboxKey } from '../src/chats/controller'
import {
  prepareEnvironmentOutbox,
  chooseEnvironment,
  environmentChoiceKey,
  forgetServerChats,
  workspacesEnvironments,
} from '../src/chats/environments'
import { environmentRecord } from '../src/fleet/factories'
import { memoryStores } from '../src/servers/registry'

const workspaces = (id: string, extra: Partial<ReturnType<typeof environmentRecord>> = {}) =>
  environmentRecord({ id, name: id, kind: 'workspaces', capabilities: ['mobile-api'], ...extra })

describe('workspaces environments', () => {
  it('lists only the environments that host workspaces, in the server’s order', () => {
    const list = [environmentRecord({ id: 'bots', name: 'Bots' }), workspaces('personal'), workspaces('company')]
    expect(workspacesEnvironments(list).map((item) => item.id)).toEqual(['personal', 'company'])
  })

  it('keeps the one the person chose while it exists', () => {
    const list = [workspaces('personal'), workspaces('company', { lifecycle: 'stopped' })]
    expect(chooseEnvironment(list, 'company')).toBe('company')
  })

  it('otherwise opens the first that runs and speaks to phones, then the first that runs, then the first', () => {
    expect(
      chooseEnvironment(
        [workspaces('old', { capabilities: [] }), workspaces('stopped', { lifecycle: 'stopped' }), workspaces('ok')],
        null
      )
    ).toBe('ok')
    expect(
      chooseEnvironment(
        [workspaces('stopped', { lifecycle: 'stopped' }), workspaces('old', { capabilities: [] })],
        null
      )
    ).toBe('old')
    expect(
      chooseEnvironment([workspaces('a', { lifecycle: 'stopped' }), workspaces('b', { lifecycle: 'starting' })], null)
    ).toBe('a')
  })

  it('falls back when the chosen one was removed, and has none to open without workspaces', () => {
    expect(chooseEnvironment([workspaces('personal')], 'deleted')).toBe('personal')
    expect(chooseEnvironment([environmentRecord({ id: 'bots', name: 'Bots' })], 'bots')).toBeNull()
    expect(chooseEnvironment([], null)).toBeNull()
  })

  it('moves the messages a phone kept before it told environments apart to the one it opens', async () => {
    const { kv } = memoryStores()
    await kv.set('chat-outbox.s1', '[1]')
    await prepareEnvironmentOutbox(kv, 's1', 'personal')
    expect(await kv.get(chatOutboxKey('s1', 'personal'))).toBe('[1]')
    expect(await kv.get('chat-outbox.s1')).toBeNull()
    // Once moved, nothing moves again, and an environment's own messages are never replaced.
    await kv.set('chat-outbox.s1', '[2]')
    await prepareEnvironmentOutbox(kv, 's1', 'personal')
    expect(await kv.get(chatOutboxKey('s1', 'personal'))).toBe('[1]')
  })

  it('forgets a server’s choice and the messages of every environment the phone opened', async () => {
    const { kv } = memoryStores()
    await kv.set(environmentChoiceKey('s1'), 'company')
    for (const id of ['personal', 'company']) {
      await prepareEnvironmentOutbox(kv, 's1', id)
      await kv.set(chatOutboxKey('s1', id), '[]')
    }
    await kv.set(chatOutboxKey('s2', 'personal'), '[]')
    await forgetServerChats(kv, 's1')
    expect(await kv.get(environmentChoiceKey('s1'))).toBeNull()
    expect(await kv.get(chatOutboxKey('s1', 'personal'))).toBeNull()
    expect(await kv.get(chatOutboxKey('s1', 'company'))).toBeNull()
    expect(await kv.get(chatOutboxKey('s2', 'personal'))).toBe('[]')
  })
})
