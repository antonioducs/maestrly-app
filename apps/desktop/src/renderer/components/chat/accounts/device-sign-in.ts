import type { ChatSubscriptionProviderKind } from '../../../../shared/chat'

/** Where each device-code sign-in enters its code; a page anywhere else is neither shown nor opened. */
const DEVICE_SIGN_IN_PAGES: Partial<Record<ChatSubscriptionProviderKind, { origin: string; pathname: string }>> = {
  'github-copilot-subscription': { origin: 'https://github.com', pathname: '/login/device' },
}

/** The provider's verification page from a device-code sign-in, or null when the link is not that page. */
export function deviceSignInUrl(kind: ChatSubscriptionProviderKind, value: string | undefined): string | null {
  const page = DEVICE_SIGN_IN_PAGES[kind]
  if (!page || !value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.username || url.password || url.hash) return null
  // The pre-filled form (`verification_uri_complete`) is the same page with a query.
  return url.origin === page.origin && url.pathname === page.pathname ? url.href : null
}
