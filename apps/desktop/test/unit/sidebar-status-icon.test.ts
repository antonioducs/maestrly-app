import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import en from '../../src/shared/i18n/en/ui'
import ptBR from '../../src/shared/i18n/pt-BR/ui'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import { StatusIcon, type AgentStatus } from '../../src/renderer/components/sidebar/StatusIcon'

const render = (status: AgentStatus) => renderToStaticMarkup(createElement(StatusIcon, { status }))

describe('sidebar status icon', () => {
  it('explains the red error status on hover and to screen readers', () => {
    const html = render('error')
    expect(html).toContain('title="sidebar.statusError"')
    expect(html).toContain('aria-label="sidebar.statusError"')
    expect(html).toContain('role="img"')
    expect(html).toContain('text-status-error')
    expect(en.sidebar.statusError).toMatch(/failed/)
    expect(ptBR.sidebar.statusError).toMatch(/falhou/)
  })

  it.each(['idle', 'working', 'ready', 'waiting', 'asking'] as const)('keeps %s unchanged', (status) => {
    expect(render(status)).not.toContain('sidebar.statusError')
  })
})
