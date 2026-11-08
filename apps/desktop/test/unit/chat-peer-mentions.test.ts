import { describe, it, expect } from 'vitest'
import {
  filterPeerMentionOptions,
  findPeerMentions,
  peerMentionMatchRange,
  type PeerMentionOption,
} from '../../src/shared/chat-peer-mentions'

const peer = (id: string, name: string, role = '', enabled = true): PeerMentionOption => ({
  id,
  name,
  role,
  tint: '#13a394',
  enabled,
})

const nina = peer('nina', 'Nina', 'Design reviews')
const nova = peer('nova', 'Nova', 'Reviews pull requests', false)
const code = peer('code', 'Code', 'Writes code')
const codeReviewer = peer('code-reviewer', 'Code Reviewer', 'Checks changes')
const joao = peer('joao', 'João', 'Infra')

/** `@` mentions of other bots in a bot's conversation. */
describe('filterPeerMentionOptions', () => {
  it('keeps every bot in the given order without a query', () => {
    expect(filterPeerMentionOptions([nova, nina], '')).toEqual([nova, nina])
    expect(filterPeerMentionOptions([nova, nina], '  ')).toEqual([nova, nina])
  })

  it('ranks names that start with the query before names and roles that contain it', () => {
    const designer = peer('d', 'Designer', 'Draws')
    const ines = peer('i', 'Inês', 'Writes')
    const writer = peer('w', 'Writer', 'Design copy')
    expect(filterPeerMentionOptions([writer, ines, designer], 'des').map((item) => item.id)).toEqual(['d', 'w'])
    expect(filterPeerMentionOptions([writer, ines, designer], 'nes').map((item) => item.id)).toEqual(['i'])
    expect(filterPeerMentionOptions([ines, nina], 'n').map((item) => item.id)).toEqual(['nina', 'i'])
  })

  it('ignores case and accents', () => {
    expect(filterPeerMentionOptions([nina, joao], 'JOAO')).toEqual([joao])
    expect(filterPeerMentionOptions([nina, joao], 'joão')).toEqual([joao])
  })

  it('returns nothing when no bot matches', () => {
    expect(filterPeerMentionOptions([nina, nova], 'zz')).toEqual([])
  })
})

describe('peerMentionMatchRange', () => {
  it('finds the matched part of a name, ignoring case and accents', () => {
    expect(peerMentionMatchRange('João', 'ao')).toEqual({ start: 2, end: 4 })
    expect(peerMentionMatchRange('Nina', 'IN')).toEqual({ start: 1, end: 3 })
  })

  it('returns null without a query or a match', () => {
    expect(peerMentionMatchRange('Nina', '')).toBeNull()
    expect(peerMentionMatchRange('Nina', 'x')).toBeNull()
  })
})

describe('findPeerMentions', () => {
  it('finds the mentions of known bots with their ranges', () => {
    const text = 'ask @Nina and @Nova about it'
    const found = findPeerMentions(text, [nina, nova])
    expect(found.map((match) => match.peer.id)).toEqual(['nina', 'nova'])
    expect(found.map((match) => text.slice(match.index, match.end))).toEqual(['@Nina', '@Nova'])
  })

  it('matches at the start of the text and before punctuation', () => {
    expect(findPeerMentions('@Nina, please', [nina])).toEqual([{ index: 0, end: 5, peer: nina }])
    expect(findPeerMentions('(@Nina)', [nina])).toEqual([{ index: 1, end: 6, peer: nina }])
  })

  it('prefers the longest name, including names with spaces', () => {
    const text = 'ping @Code Reviewer now, then @Code'
    const found = findPeerMentions(text, [code, codeReviewer])
    expect(found.map((match) => text.slice(match.index, match.end))).toEqual(['@Code Reviewer', '@Code'])
    expect(found.map((match) => match.peer.id)).toEqual(['code-reviewer', 'code'])
  })

  it('needs a boundary after the name', () => {
    expect(findPeerMentions('@Ninas are here', [nina])).toEqual([])
    expect(findPeerMentions('@Nina2', [nina])).toEqual([])
  })

  it('ignores an @ inside an e-mail address', () => {
    expect(findPeerMentions('write to team@Nina.dev', [nina])).toEqual([])
  })

  it('matches the exact name only', () => {
    expect(findPeerMentions('@nina', [nina])).toEqual([])
  })

  it('takes the first bot of a repeated name', () => {
    const other = peer('nina-2', 'Nina', 'Other')
    expect(findPeerMentions('@Nina', [nina, other])[0].peer.id).toBe('nina')
  })

  it('returns nothing without an @ or known bots', () => {
    expect(findPeerMentions('Nina', [nina])).toEqual([])
    expect(findPeerMentions('@Nina', [])).toEqual([])
  })
})
