import { afterEach, describe, expect, it } from 'vitest'
import {
  clearHumanTurnOrigin,
  recordHumanTurnOrigin,
  type HumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import {
  assertConversationTurnProvenanceCurrent,
  clearLinkedTurnOrigin,
  currentConversationTurnProvenance,
  currentLinkedTurnOrigin,
  hopAllowed,
  recordLinkedTurnOrigin,
  type LinkedTurnOrigin,
} from '../../src/main/chat/conversation-link-authorization'

const linked: LinkedTurnOrigin[] = []
const human: HumanTurnOrigin[] = []

function linkedTurn(overrides: Partial<LinkedTurnOrigin> = {}): LinkedTurnOrigin {
  const origin: LinkedTurnOrigin = {
    token: {},
    conversationId: 'child',
    messageId: 'seed-1',
    peerConversationId: 'source',
    hop: 1,
    reportBack: false,
    signal: new AbortController().signal,
    ...overrides,
  }
  recordLinkedTurnOrigin(origin)
  linked.push(origin)
  return origin
}

function humanTurn(conversationId = 'child'): HumanTurnOrigin {
  const origin = { token: {}, conversationId, messageId: 'typed-1', text: 'oi', signal: new AbortController().signal }
  recordHumanTurnOrigin(origin)
  human.push(origin)
  return origin
}

afterEach(() => {
  for (const origin of linked.splice(0)) clearLinkedTurnOrigin(origin.conversationId, origin.token)
  for (const origin of human.splice(0)) clearHumanTurnOrigin(origin.conversationId, origin.token)
})

describe('linked turn provenance', () => {
  it('records and clears a linked turn by its token only', () => {
    const first = linkedTurn()
    expect(currentLinkedTurnOrigin('child')).toBe(first)
    const second = linkedTurn({ messageId: 'seed-2' })
    clearLinkedTurnOrigin('child', first.token)
    expect(currentLinkedTurnOrigin('child')).toBe(second)
    clearLinkedTurnOrigin('child', second.token)
    expect(currentLinkedTurnOrigin('child')).toBeNull()
  })

  it('reports a linked turn with its hop and sender', () => {
    const origin = linkedTurn({ hop: 2, reportBack: true })
    expect(currentConversationTurnProvenance('child')).toEqual({ kind: 'linked', ...origin })
  })

  it('reports a typed turn as human with hop 0, and a typed turn wins', () => {
    linkedTurn()
    const typed = humanTurn()
    expect(currentConversationTurnProvenance('child')).toEqual({
      kind: 'human',
      token: typed.token,
      conversationId: 'child',
      messageId: 'typed-1',
      hop: 0,
      signal: typed.signal,
    })
  })

  it('reports nothing without a live turn', () => {
    expect(currentConversationTurnProvenance('child')).toBeNull()
    const controller = new AbortController()
    linkedTurn({ signal: controller.signal })
    controller.abort()
    expect(currentLinkedTurnOrigin('child')).toBeNull()
    expect(currentConversationTurnProvenance('child')).toBeNull()
  })

  it('expires the provenance captured for a turn once a newer turn starts', () => {
    linkedTurn()
    const captured = currentConversationTurnProvenance('child')!
    expect(() => assertConversationTurnProvenanceCurrent(captured)).not.toThrow()
    linkedTurn({ messageId: 'seed-2' })
    expect(() => assertConversationTurnProvenanceCurrent(captured)).toThrow(/no longer active/)

    humanTurn()
    const typed = currentConversationTurnProvenance('child')!
    expect(() => assertConversationTurnProvenanceCurrent(typed)).not.toThrow()
    humanTurn()
    expect(() => assertConversationTurnProvenanceCurrent(typed)).toThrow(/no longer active/)
  })

  it('allows at most three agent-to-agent turns after each typed message', () => {
    expect(hopAllowed(0, 1)).toBe(true)
    expect(hopAllowed(2, 1)).toBe(true)
    expect(hopAllowed(3, 1)).toBe(false)
    expect(hopAllowed(1, 2)).toBe(true)
    expect(hopAllowed(2, 2)).toBe(false)
  })
})
