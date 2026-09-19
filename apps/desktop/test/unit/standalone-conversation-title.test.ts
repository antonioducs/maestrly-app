import { afterEach, beforeEach, expect, it } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { getConversation, getDb, insertConversation } from '../../src/main/store'
import { nameStandaloneConversationFromText } from '../../src/main/standalone-conversation-title'

beforeEach(() => {
  freshDb()
  insertConversation({
    id: 'chat',
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: 'New chat',
    cwd: '/private/chat',
    status: 'idle',
    createdAt: 1,
    lastActivityAt: 1,
    archived: 0,
    pinnedAt: null,
  })
  getDb().exec(`UPDATE conversations SET ui_prefs='{"autoName":true,"chat":{"mode":"ask"}}'`)
})
afterEach(closeDb)

it('names once from visible text and preserves unrelated preferences', () => {
  expect(nameStandaloneConversationFromText('chat', '  Plan\n  a family trip  ')).toBe(true)
  expect(getConversation('chat')).toMatchObject({
    name: 'Plan a family trip',
    uiPrefs: { autoName: false, chat: { mode: 'ask' } },
  })
  expect(nameStandaloneConversationFromText('chat', 'Later message')).toBe(false)
  expect(getConversation('chat')?.name).toBe('Plan a family trip')
})

it('does not overwrite a manual rename or generate a name for attachment-only messages', () => {
  expect(nameStandaloneConversationFromText('chat', '  ')).toBe(false)
  getDb().exec(`UPDATE conversations SET name='Manual name', ui_prefs=json_set(ui_prefs,'$.autoName',json('false'))`)
  expect(nameStandaloneConversationFromText('chat', 'Delayed first message')).toBe(false)
  expect(getConversation('chat')?.name).toBe('Manual name')
})
