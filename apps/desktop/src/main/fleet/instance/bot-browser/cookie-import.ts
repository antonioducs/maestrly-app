import type { CdpPipe } from './cdp-pipe'

/** A cookie as Electron's `session.cookies.get` reports it. */
export interface SharedCookie {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  httpOnly?: boolean
  session?: boolean
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

const SAME_SITE = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const
const BATCH = 100

/**
 * The cookie for `Storage.setCookies`. A host-only cookie is set through its URL: given a domain, Chromium would make it
 * a domain cookie that its subdomains also receive. Null for a cookie without a name or domain.
 */
export function toChromiumCookie(cookie: SharedCookie): Record<string, unknown> | null {
  const domain = cookie.domain?.trim()
  if (!cookie.name || !domain) return null
  const path = cookie.path || '/'
  const hostOnly = cookie.hostOnly ?? !domain.startsWith('.')
  const sameSite = cookie.sameSite && cookie.sameSite !== 'unspecified' ? SAME_SITE[cookie.sameSite] : undefined
  return {
    name: cookie.name,
    value: cookie.value,
    ...(hostOnly ? { url: `${cookie.secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${path}` } : { domain }),
    path,
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(!cookie.session && typeof cookie.expirationDate === 'number' ? { expires: cookie.expirationDate } : {}),
  }
}

/**
 * Copies the environment's shared site logins into a bot's own Chromium. A batch the browser refuses is retried one
 * cookie at a time, so one cookie it rejects (such as `SameSite=None` without `Secure`) costs only itself.
 */
export async function importSharedCookies(
  pipe: Pick<CdpPipe, 'send'>,
  cookies: readonly SharedCookie[]
): Promise<{ imported: number; failed: number }> {
  const converted = cookies.map(toChromiumCookie).filter((cookie): cookie is Record<string, unknown> => !!cookie)
  let imported = 0
  let failed = cookies.length - converted.length
  for (let start = 0; start < converted.length; start += BATCH) {
    const batch = converted.slice(start, start + BATCH)
    try {
      await pipe.send('Storage.setCookies', { cookies: batch })
      imported += batch.length
      continue
    } catch {
      /* One cookie of the batch may be the one refused: try them one by one. */
    }
    for (const cookie of batch) {
      try {
        await pipe.send('Storage.setCookies', { cookies: [cookie] })
        imported++
      } catch {
        failed++
      }
    }
  }
  return { imported, failed }
}
