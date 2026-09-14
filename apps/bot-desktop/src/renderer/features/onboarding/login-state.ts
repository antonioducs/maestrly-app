import type { AuthStatus } from '@maestrly/host-protocol'

// Older runtimes can report a stale account/read after returning a device code.
// Keep the issued challenge in memory until a definitive result, cancel or expiry.
export function mergeLoginStatus(previous: AuthStatus | undefined, next: AuthStatus, now: number): AuthStatus {
  if (next.state === 'connected' || next.state === 'incompatible' || next.state === 'expired') return next
  const pending = next.state === 'connecting' ? next : previous?.state === 'connecting' ? previous : undefined
  if (!pending?.pending) return next
  if (Date.parse(pending.pending.expiresAt) <= now) return { state: 'expired', provider: pending.provider }
  return pending
}
