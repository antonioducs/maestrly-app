import { describe, expect, it } from 'vitest'
import { chatWindowKey, parseChatWindowKey, type ChatWindowTarget } from '../../src/shared/chat-window'

const SERVER = 'aaaaaaaa-0000-4000-8000-000000000001'

describe('chat window keys', () => {
  it('reads back the target of a key and refuses anything else', () => {
    const targets = [
      { kind: 'conversation', id: 'chat-1' },
      { kind: 'bot', serverId: SERVER, id: 'alex' },
    ] as ChatWindowTarget[]
    for (const target of targets) expect(parseChatWindowKey(chatWindowKey(target))).toEqual(target)
    for (const key of ['bot:alex', 'bot:Server/alex', `bot:${SERVER}/`, 'conversation:', 'url:x'])
      expect(parseChatWindowKey(key)).toBeNull()
  })
})
