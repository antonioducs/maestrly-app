import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import enChat from '../../src/shared/i18n/en/chat'
import ptBrChat from '../../src/shared/i18n/pt-BR/chat'

const subscriptionAccount = readFileSync(
  new URL('../../src/renderer/components/chat/accounts/SubscriptionAccount.tsx', import.meta.url),
  'utf8'
)
const serviceSource = readFileSync(new URL('../../src/main/chat/service.ts', import.meta.url), 'utf8')

describe('subscription sign-in link contract', () => {
  it('shows the pending sign-in page only while signing in, with copy and open actions', () => {
    expect(subscriptionAccount).toContain('const pendingLoginUrl = signingIn ? status?.authUrl : undefined')
    expect(subscriptionAccount).toContain('{pendingLoginUrl && (')
    expect(subscriptionAccount).toContain('navigator.clipboard.writeText(url)')
    expect(subscriptionAccount).toContain('window.api.openExternalUrl(pendingLoginUrl)')
    expect(subscriptionAccount).toContain("t('settings.subscriptionLoginLinkHint')")
  })

  it("opens Google AI sign-in through the main process, in the user's own browser", () => {
    expect(serviceSource).toContain('openBrowser: (url) => void shell.openExternal(url).catch(() => undefined)')
  })

  it('translates every sign-in link string', () => {
    for (const catalog of [enChat, ptBrChat]) {
      for (const key of [
        'subscriptionLoginLinkHint',
        'subscriptionLoginLinkCopy',
        'subscriptionLoginLinkCopied',
        'subscriptionLoginLinkOpen',
      ] as const) {
        expect(catalog.settings[key]).toEqual(expect.any(String))
      }
    }
  })
})
