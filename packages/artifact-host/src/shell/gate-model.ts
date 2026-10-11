// Which screen a visitor sees on arrival. No DOM here, so the rule is tested directly.
import type { ViewerGate, ViewerState } from './contract.js'

export interface LinkFragment {
  /** A single-use owner ticket. */
  owner?: string
  /** A personal link's token. */
  invite?: string
  version?: number
  /** The page alone, without comments: what the desktop captures for a preview image. */
  preview?: boolean
}

export type EntryScreen =
  | { screen: 'viewer' }
  | { screen: 'invite'; token: string }
  | { screen: 'request' }
  | { screen: 'waiting' }
  | { screen: 'denied' }
  | { screen: 'guest'; code: boolean }
  | { screen: 'unavailable' }

/** How often a waiting browser asks whether its request was answered. */
export const POLL_INTERVAL_MS = 5000

/** Tokens travel after `#`, which browsers never send to a server. */
export function parseFragment(hash: string): LinkFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const fragment: LinkFragment = {}
  const owner = params.get('o')
  const invite = params.get('i')
  const version = params.get('v') ?? ''
  if (owner) fragment.owner = owner
  if (invite) fragment.invite = invite
  if (/^[1-9]\d{0,8}$/.test(version)) fragment.version = Number(version)
  if (params.get('preview') === '1') fragment.preview = true
  return fragment
}

export const hasAccess = (state: ViewerState | ViewerGate | null): state is ViewerState =>
  state !== null && 'artifact' in state

export function entryScreen(input: { fragment: LinkFragment; state: ViewerState | ViewerGate | null }): EntryScreen {
  const { fragment, state } = input
  // An invitation is shown even to someone already in: it says who they are about to be on this page.
  if (fragment.invite) return { screen: 'invite', token: fragment.invite }
  if (state === null) return { screen: 'unavailable' }
  if (hasAccess(state)) return { screen: 'viewer' }
  const { gate } = state
  if (gate.pending === 'pending') return { screen: 'waiting' }
  if (gate.pending === 'denied') return { screen: 'denied' }
  if (gate.guest) return { screen: 'guest', code: gate.code }
  if (gate.request) return { screen: 'request' }
  return { screen: 'unavailable' }
}
