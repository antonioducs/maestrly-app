import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import enChat from '../../src/shared/i18n/en/chat'
import ptBrChat from '../../src/shared/i18n/pt-BR/chat'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { DeviceCodeSignIn } from '../../src/renderer/components/chat/accounts/DeviceCodeSignIn'
import { deviceSignInUrl } from '../../src/renderer/components/chat/accounts/device-sign-in'

const subscriptionAccount = readFileSync(
  new URL('../../src/renderer/components/chat/accounts/SubscriptionAccount.tsx', import.meta.url),
  'utf8'
)

const deviceUrl = 'https://github.com/login/device'

function props(overrides: Partial<Parameters<typeof DeviceCodeSignIn>[0]> = {}) {
  return {
    hint: 'settings.githubCopilotSubscriptionDeviceCodeHint',
    userCode: '76B6-D6BE',
    verificationUrl: deviceUrl,
    copied: null,
    onCopy: vi.fn(),
    onOpen: vi.fn(),
    buttonClassName: 'button',
    ...overrides,
  }
}

type ButtonProps = { onClick: () => void; children: ReactNode }

/** The card's buttons, found in the tree the component returns, so a test can press them without a DOM. */
function buttons(node: ReactNode): ReactElement<ButtonProps>[] {
  if (Array.isArray(node)) return node.flatMap(buttons)
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  if (node.type === 'button') return [node as ReactElement<ButtonProps>]
  return buttons(node.props.children)
}

function label(button: ReactElement<ButtonProps>): string {
  return ([] as ReactNode[])
    .concat(button.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

function press(tree: ReactNode, text: string): void {
  const button = buttons(tree).find((candidate) => label(candidate) === text)
  if (!button) throw new Error(`no button labeled ${text}`)
  button.props.onClick()
}

describe('device sign-in link', () => {
  it('accepts only the GitHub device page for GitHub Copilot', () => {
    expect(deviceSignInUrl('github-copilot-subscription', deviceUrl)).toBe(deviceUrl)
    expect(deviceSignInUrl('github-copilot-subscription', `${deviceUrl}?user_code=76B6-D6BE`)).toBe(
      `${deviceUrl}?user_code=76B6-D6BE`
    )
    for (const rejected of [
      undefined,
      '',
      'not a url',
      'http://github.com/login/device',
      'https://github.com.evil.io/login/device',
      'https://evil.io/login/device',
      'https://gist.github.com/login/device',
      'https://github.com:8443/login/device',
      'https://user:pw@github.com/login/device',
      'https://github.com/login/device/extra',
      'https://github.com/login/oauth/authorize',
      'https://github.com/login/device#fragment',
      'javascript:alert(1)',
    ]) {
      expect(deviceSignInUrl('github-copilot-subscription', rejected)).toBeNull()
    }
  })

  it('shows no device link for a provider without a known device page', () => {
    for (const kind of ['codex-subscription', 'grok-subscription', 'claude-subscription'] as const) {
      expect(deviceSignInUrl(kind, deviceUrl)).toBeNull()
    }
  })
})

describe('device sign-in card', () => {
  it('shows the code with Copy code, and the page with Copy link and Open in browser', () => {
    const html = renderToStaticMarkup(createElement(DeviceCodeSignIn, props()))
    expect(html).toContain('settings.githubCopilotSubscriptionDeviceCodeHint')
    expect(html).toContain('76B6-D6BE')
    expect(html).toContain('settings.subscriptionDeviceCodeCopy')
    expect(html).toContain('data-subscription-device-link')
    expect(html).toContain('settings.subscriptionDeviceLinkHint')
    expect(html).toContain(deviceUrl)
    expect(html).toContain('settings.subscriptionLoginLinkCopy')
    expect(html).toContain('settings.subscriptionLoginLinkOpen')
  })

  it('still shows the code and its copy button when there is no valid page', () => {
    const html = renderToStaticMarkup(createElement(DeviceCodeSignIn, props({ verificationUrl: null })))
    expect(html).toContain('76B6-D6BE')
    expect(html).toContain('settings.subscriptionDeviceCodeCopy')
    expect(html).not.toContain('data-subscription-device-link')
    expect(html).not.toContain('settings.subscriptionLoginLinkOpen')
  })

  it('copies the code, copies the link and opens the link', () => {
    const card = props()
    const tree = DeviceCodeSignIn(card)
    press(tree, 'settings.subscriptionDeviceCodeCopy')
    expect(card.onCopy).toHaveBeenLastCalledWith('76B6-D6BE')
    press(tree, 'settings.subscriptionLoginLinkCopy')
    expect(card.onCopy).toHaveBeenLastCalledWith(deviceUrl)
    press(tree, 'settings.subscriptionLoginLinkOpen')
    expect(card.onOpen).toHaveBeenCalledWith(deviceUrl)
    expect(card.onCopy).toHaveBeenCalledTimes(2)
  })

  it('marks only the copied item as copied', () => {
    const codeCopied = buttons(DeviceCodeSignIn(props({ copied: '76B6-D6BE' }))).map(label)
    expect(codeCopied).toEqual([
      'settings.subscriptionLoginLinkCopied',
      'settings.subscriptionLoginLinkCopy',
      'settings.subscriptionLoginLinkOpen',
    ])
    const linkCopied = buttons(DeviceCodeSignIn(props({ copied: deviceUrl }))).map(label)
    expect(linkCopied).toEqual([
      'settings.subscriptionDeviceCodeCopy',
      'settings.subscriptionLoginLinkCopied',
      'settings.subscriptionLoginLinkOpen',
    ])
  })

  it('checks the device page before the account card opens or shows it', () => {
    expect(subscriptionAccount).toContain(
      'const loginUrl = result.authUrl ?? deviceSignInUrl(providerKind, result.verificationUrl)'
    )
    expect(subscriptionAccount).toContain(
      'const deviceLoginUrl = signingIn ? deviceSignInUrl(providerKind, loginInstructions?.verificationUrl) : null'
    )
    expect(subscriptionAccount).toContain('verificationUrl={deviceLoginUrl}')
    expect(subscriptionAccount).not.toContain('loginInstructions.verificationUrl}')
  })

  it('translates the device sign-in strings', () => {
    for (const catalog of [enChat, ptBrChat]) {
      for (const key of ['subscriptionDeviceCodeCopy', 'subscriptionDeviceLinkHint'] as const) {
        expect(catalog.settings[key]).toEqual(expect.any(String))
      }
    }
  })
})
