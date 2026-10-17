import type { MobileChatItem } from '@maestrly/bot-fleet-protocol'
import { describe, expect, it } from 'vitest'
import { transcriptRows } from '../src/fleet/transcript-rows'
import { editableItemId, rowText, searchKey, searchRows } from '../src/fleet/transcript-search'

let second = 0
const at = () => `2026-10-12T12:00:${String(second++).padStart(2, '0')}.000Z`
const user = (id: string, text: string, extra: Partial<Extract<MobileChatItem, { kind: 'user' }>> = {}) =>
  ({
    id,
    at: at(),
    kind: 'user',
    text,
    source: 'owner',
    queued: false,
    memories: [],
    images: [],
    ...extra,
  }) as MobileChatItem
const said = (id: string, text: string): MobileChatItem => ({ id, at: at(), kind: 'assistant', text, streaming: false })
const tool = (id: string, target: string): MobileChatItem => ({
  id,
  at: at(),
  kind: 'tool',
  name: 'bash',
  target,
  state: 'done',
  output: 'ok',
  images: [],
})

describe('conversation search', () => {
  it('compares without case or accents', () => {
    expect(searchKey('Ação RÁPIDA')).toBe('acao rapida')
  })

  it('finds messages, and what the agent did inside its activity', () => {
    const rows = transcriptRows([
      user('u1', 'Fix the splash'),
      tool('t1', 'npm run splash:export'),
      said('a1', 'Done, the Splash animates now.'),
      user('u2', 'Thanks'),
    ])
    expect(rows.map((row) => (row.kind === 'item' ? row.item.id : `${row.kind}:${row.id}`))).toEqual([
      'u1',
      'a1',
      'activity:t1',
      'u2',
    ])
    expect(searchRows(rows, 'splash')).toEqual([0, 1, 2])
    expect(rowText(rows[2])).toContain('npm run splash:export')
    expect(searchRows([null, ...rows], 'thanks')).toEqual([4])
    expect(searchRows(rows, '   ')).toEqual([])
  })

  it('finds a permission request by the command it would run', () => {
    const permission: MobileChatItem = {
      id: 'perm:p1',
      at: at(),
      kind: 'permission',
      requestId: 'p1',
      title: 'Run command (2 lines)',
      detail: null,
      tool: { name: 'bash', target: 'uname -sr\nnproc' },
      state: 'pending',
      resolvedAt: null,
    }
    const rows = transcriptRows([permission])
    expect(searchRows(rows, 'nproc')).toEqual([0])
  })

  it('lets the person edit only their own last message, once nothing waits', () => {
    expect(editableItemId([user('m1:0', 'a'), said('a1', 'x'), user('m2:0', 'b')], 'chat')).toBe('m2:0')
    expect(editableItemId([user('m1:0', 'a'), user('m2:0', 'b', { queued: true })], 'chat')).toBeNull()
    expect(editableItemId([user('m1:0', 'a', { source: 'routine' })], 'chat')).toBeNull()
    expect(
      editableItemId(
        [
          user('m1:0', 'a', {
            fromConversation: { conversationId: 'c2', name: 'Other', purpose: 'report' },
          } as never),
        ],
        'chat'
      )
    ).toBeNull()
    expect(editableItemId([user('input:i1', 'a')], 'bot')).toBe('input:i1')
    expect(editableItemId([user('m1:0', 'a')], 'bot')).toBeNull()
    expect(editableItemId([said('a1', 'x')], 'chat')).toBeNull()
  })
})
