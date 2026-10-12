import { freezeFailoverChain } from '../../chat/subscription-failover/config'
import { getSubscriptionFailoverRouter, type SubscriptionFailoverRouter } from '../../chat/subscription-failover/router'

/** Admission errors of a turn whose accounts, with their failover lists, have all reached their usage limits. */
const EXHAUSTED_CODES: ReadonlySet<string> = new Set(['claude-accounts-exhausted', 'codex-accounts-exhausted'])
/** The first wait after a turn could not start; each failure in a row doubles it, up to the maximum. */
export const START_RETRY_MIN_MS = 5_000
export const START_RETRY_MAX_MS = 5 * 60_000
/**
 * While its accounts wait out a usage limit, a bot still checks again this often: the owner may connect another
 * account or add one to the failover list meanwhile, and a weekly limit would otherwise hold the queue for days.
 */
export const QUOTA_RECHECK_MS = 10 * 60_000

export interface StartRetry {
  /** When the bot tries to start the turn again. */
  at: number
  /** The failure's kind: a failure in a row of the same kind is not reported again. */
  key: string
  /** The transcript text: an exhausted code carries ` until=<ISO time>` once that time is known. */
  text: string
}

/**
 * When a bot tries again to start a queued turn after `failures` failures in a row (this one included). A turn its
 * accounts refused for their usage limits waits until the first of them may take a turn again; any other failure waits
 * twice as long as the one before, so a bot never retries every few seconds forever.
 */
export function startRetry(
  error: unknown,
  failures: number,
  /** The provider the bot's turns use; read only for a usage limit. */
  selectedProvider: () => string | null,
  now = Date.now(),
  router: Pick<SubscriptionFailoverRouter, 'recoveryAt'> = getSubscriptionFailoverRouter()
): StartRetry {
  const message = error instanceof Error ? error.message : ''
  const backoff = now + Math.min(START_RETRY_MAX_MS, START_RETRY_MIN_MS * 2 ** Math.max(0, failures - 1))
  if (!EXHAUSTED_CODES.has(message)) return { at: backoff, key: message, text: message.slice(0, 400) || 'Turn failed.' }
  const providerId = selectedProvider()
  const chain = providerId ? freezeFailoverChain(providerId) : []
  const recovery = router.recoveryAt(chain.length ? chain : providerId ? [providerId] : [], now)
  // The router may already admit an account its admission refused a moment ago (its probe time just came).
  if (recovery <= now) return { at: backoff, key: message, text: message }
  return {
    at: Math.max(now + START_RETRY_MIN_MS, Math.min(recovery, now + QUOTA_RECHECK_MS)),
    key: message,
    text: `${message} until=${new Date(recovery).toISOString()}`,
  }
}
