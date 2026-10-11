const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Requests per minute. They do not rely on client IPs: behind a proxy such as Tailscale, all arrive from loopback. */
const REQUESTS_PER_MINUTE = { host: 600, artifact: 300, session: 120 } as const
const CODE_FAILURES_PER_BROWSER = 5
const CODE_LOCK_MS = 15 * MINUTE_MS
const CODE_ATTEMPTS_PER_ARTIFACT = 100
/** Above this many tracked keys, the ones whose window already ended are dropped. */
const PRUNE_ABOVE = 5_000

export type RateScope = keyof typeof REQUESTS_PER_MINUTE

export interface RateLimiter {
  allow(scope: RateScope, key: string): boolean
  /** Whether this browser may try an access code now; an allowed attempt counts toward the artifact's hourly cap. */
  codeAttempt(artifactId: string, browserKey: string): { allowed: boolean; retryAfterMs: number }
  codeFailed(artifactId: string, browserKey: string): void
}

interface Window {
  start: number
  count: number
}

/** In-memory limits, reset when the host restarts. */
export function createRateLimiter(clock: () => number): RateLimiter {
  const requests = new Map<string, Window>()
  const attempts = new Map<string, Window>()
  const failures = new Map<string, { count: number; lockedUntil: number }>()

  function take(
    map: Map<string, Window>,
    key: string,
    limit: number,
    span: number
  ): { ok: boolean; retryAfterMs: number } {
    const now = clock()
    let window = map.get(key)
    if (!window || now - window.start >= span) {
      if (map.size > PRUNE_ABOVE) for (const [k, w] of map) if (now - w.start >= span) map.delete(k)
      window = { start: now, count: 0 }
      map.set(key, window)
    }
    if (window.count >= limit) return { ok: false, retryAfterMs: window.start + span - now }
    window.count++
    return { ok: true, retryAfterMs: 0 }
  }

  return {
    allow: (scope, key) => take(requests, `${scope}\n${key}`, REQUESTS_PER_MINUTE[scope], MINUTE_MS).ok,

    codeAttempt(artifactId, browserKey) {
      const now = clock()
      const failed = failures.get(`${artifactId}\n${browserKey}`)
      if (failed && failed.lockedUntil > now) return { allowed: false, retryAfterMs: failed.lockedUntil - now }
      const taken = take(attempts, artifactId, CODE_ATTEMPTS_PER_ARTIFACT, HOUR_MS)
      return { allowed: taken.ok, retryAfterMs: taken.retryAfterMs }
    },

    codeFailed(artifactId, browserKey) {
      const now = clock()
      const key = `${artifactId}\n${browserKey}`
      if (failures.size > PRUNE_ABOVE)
        for (const [k, f] of failures) if (f.lockedUntil <= now && k !== key) failures.delete(k)
      const failed = failures.get(key) ?? { count: 0, lockedUntil: 0 }
      failed.count++
      if (failed.count >= CODE_FAILURES_PER_BROWSER) {
        failed.count = 0
        failed.lockedUntil = now + CODE_LOCK_MS
      }
      failures.set(key, failed)
    },
  }
}
