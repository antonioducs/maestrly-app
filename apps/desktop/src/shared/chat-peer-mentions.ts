/** A bot the owner can mention with `@` in another bot's conversation. */
export interface PeerMentionOption {
  id: string
  name: string
  role: string
  tint: string
  /** Whether the conversation's bot may already talk to this one (`talksTo`). */
  enabled: boolean
}

export interface PeerMentionMatch {
  /** Index of the `@`. */
  index: number
  /** Index just past the name. */
  end: number
  peer: PeerMentionOption
}

const WORD = /[\p{L}\p{N}_]/u

/** Case and accents do not matter to a search. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * The bots that match what follows the `@`, by name or role: names that start with it first, then names that contain
 * it, then roles; the given order otherwise.
 */
export function filterPeerMentionOptions(peers: readonly PeerMentionOption[], query: string): PeerMentionOption[] {
  const q = fold(query.trim())
  if (!q) return [...peers]
  const rank = (peer: PeerMentionOption): number => {
    const name = fold(peer.name)
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    return fold(peer.role).includes(q) ? 2 : 3
  }
  return peers
    .map((peer) => ({ peer, rank: rank(peer) }))
    .filter((item) => item.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map((item) => item.peer)
}

/** Where `query` first matches `text`, ignoring case and accents, to highlight it. */
export function peerMentionMatchRange(text: string, query: string): { start: number; end: number } | null {
  const q = fold(query.trim())
  if (!q) return null
  const start = fold(text).indexOf(q)
  return start < 0 ? null : { start, end: start + q.length }
}

/**
 * The `@Name` mentions of known bots in a draft, so its chips come back when it is shown again. A name only counts
 * after the start of the text or a non-word character (never inside an e-mail address) and before the end of the
 * text or a non-word character; the longest name wins, and the first bot of a repeated name.
 */
export function findPeerMentions(text: string, peers: readonly PeerMentionOption[]): PeerMentionMatch[] {
  if (typeof text !== 'string' || !text.includes('@') || peers.length === 0) return []
  const byLength = [...peers].filter((peer) => peer.name).sort((a, b) => b.name.length - a.name.length)
  const out: PeerMentionMatch[] = []
  let at = text.indexOf('@')
  while (at >= 0) {
    let next = at + 1
    if (at === 0 || !WORD.test(text[at - 1])) {
      const peer = byLength.find((candidate) => {
        if (!text.startsWith(candidate.name, at + 1)) return false
        const after = text[at + 1 + candidate.name.length]
        return after === undefined || !WORD.test(after)
      })
      if (peer) {
        next = at + 1 + peer.name.length
        out.push({ index: at, end: next, peer })
      }
    }
    at = text.indexOf('@', next)
  }
  return out
}
