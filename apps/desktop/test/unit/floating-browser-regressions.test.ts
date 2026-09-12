import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { floatingStripHtml } from '../../src/main/floating-strip-html'
import {
  bindFloatingStripPin,
  type FloatingStripButton,
  type FloatingStripDocument,
} from '../../src/preload/floating-strip'

describe('floating browser — subtab and pin regressions', () => {
  it('creates the strip without inline JavaScript and escapes metadata used by preload', () => {
    const html = floatingStripHtml({
      chromeHeight: 32,
      color: 'hsl(120 70% 55%)',
      convId: 'conv<&"',
      conversationName: 'Conversa <ativa>',
      pinTitle: 'Pin "now"',
      pinned: false,
      projectName: 'Projeto & time',
      tab: 'browser',
      tabTitle: 'Navegador',
      title: 'Projeto — Navegador',
      unpinTitle: 'Desafixar',
    })

    expect(html).not.toContain('<script')
    expect(html).toContain('data-maestrly-floating-pin')
    expect(html).toContain('data-conv-id="conv&lt;&amp;&quot;"')
    expect(html).toContain('data-pin-title="Pin &quot;now&quot;"')
    expect(html).toContain('Projeto &amp; time')
  })

  it('wires pinning through preload and sends the next state to main', () => {
    let click: (() => void) | undefined
    const toggle = vi.fn(() => false)
    const button: FloatingStripButton = {
      classList: { toggle },
      dataset: {
        convId: 'conv-1',
        tab: 'browser',
        pinned: 'false',
        pinTitle: 'Fixar',
        unpinTitle: 'Desafixar',
      },
      title: '',
      addEventListener: (_type, listener) => {
        click = listener
      },
    }
    const doc: FloatingStripDocument = {
      readyState: 'complete',
      querySelector: () => button,
      addEventListener: vi.fn(),
    }
    const send = vi.fn()

    expect(bindFloatingStripPin(doc, send)).toBe(true)
    expect(button.title).toBe('Fixar')
    click?.()

    expect(send).toHaveBeenCalledWith('conv-1', 'browser', true)
    expect(button.dataset.pinned).toBe('true')
    expect(button.title).toBe('Desafixar')
    expect(toggle).toHaveBeenLastCalledWith('on', true)
  })

  it('adds a new WebContentsView directly to the floating window', () => {
    const source = readFileSync(new URL('../../src/main/drawer/browser.ts', import.meta.url), 'utf8')

    expect(source).toContain("floatWinByKey.get(fkey(convId, 'browser'))")
    expect(source).toContain('owner!.contentView.addChildView(v)')
    expect(source).not.toContain('win!.contentView.addChildView(v)')
  })
})
