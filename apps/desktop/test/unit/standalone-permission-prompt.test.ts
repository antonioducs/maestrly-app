import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatPermissionRequest } from '../../src/shared/chat'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { PermissionPrompt } from '../../src/renderer/components/chat/PermissionPrompt'

const request = {
  id: 'request',
  title: 'Run command',
  resources: [],
  allowAlways: true,
} as unknown as ChatPermissionRequest

describe('standalone permission wording', () => {
  it('labels persistent permission as limited to this chat', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionPrompt, { request, scope: 'standalone', onDecide: vi.fn() })
    )
    expect(html).toContain('permPrompt.allowAlwaysChat')
  })
  it('preserves project wording and hides unsupported persistent permission', () => {
    const html = renderToStaticMarkup(createElement(PermissionPrompt, { request, scope: 'project', onDecide: vi.fn() }))
    expect(html).toContain('permPrompt.allowAlways<')
    expect(html).not.toContain('permPrompt.allowAlwaysChat')
    const onceOnly = renderToStaticMarkup(
      createElement(PermissionPrompt, {
        request: { ...request, allowAlways: false },
        scope: 'standalone',
        onDecide: vi.fn(),
      })
    )
    expect(onceOnly).not.toContain('permPrompt.allowAlways')
  })
})
