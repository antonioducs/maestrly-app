import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ChatUiProvider, ChatComposer } from '../src'
import { labels } from './labels'

function Wrap({ children }: { children: ReactNode }) {
  return <ChatUiProvider value={{ labels, openExternal: () => {}, locale: 'en' }}>{children}</ChatUiProvider>
}
const base = { onChange: () => {}, onSend: () => {}, onStop: () => {}, streaming: false }

describe('ChatComposer', () => {
  it('opens the command palette for a slash query filtered by name and description', () => {
    const commands = [
      { name: 'review', description: 'Review a file' },
      { name: 'summary', description: 'Resume the day' },
      { name: 'other', description: 'nothing' },
    ]
    const html = renderToStaticMarkup(<Wrap><ChatComposer {...base} value="/re" commands={commands} /></Wrap>)
    expect(html).toContain('/review')
    expect(html).toContain('/summary')
    expect(html).not.toContain('/other')
    expect(renderToStaticMarkup(<Wrap><ChatComposer {...base} value="hello /re" commands={commands} /></Wrap>)).not.toContain('role="listbox"')
  })
  it('shows stop while streaming, send otherwise, and the reason when disabled', () => {
    expect(renderToStaticMarkup(<Wrap><ChatComposer {...base} value="" streaming /></Wrap>)).toContain(labels.composer.stop)
    expect(renderToStaticMarkup(<Wrap><ChatComposer {...base} value="" streaming stopping /></Wrap>)).toContain(labels.composer.stopping)
    const idle = renderToStaticMarkup(<Wrap><ChatComposer {...base} value="hi" /></Wrap>)
    expect(idle).toContain(`aria-label="${labels.composer.send}"`)
    expect(idle).not.toContain('disabled=""')
    const off = renderToStaticMarkup(<Wrap><ChatComposer {...base} value="hi" disabled disabledReason="offline" /></Wrap>)
    expect(off).toMatch(/readonly=""|readOnly=""/)
    expect(off).toContain('id="composer-reason">offline<')
  })
  it('lists attachments as chips with a labelled remove button', () => {
    const html = renderToStaticMarkup(<Wrap><ChatComposer {...base} value="" attachments={[{ id: 'a', name: 'data.csv', size: 2048 }]} onRemoveAttachment={() => {}} /></Wrap>)
    expect(html).toContain('data.csv')
    expect(html).toContain(`aria-label="${labels.composer.removeAttachment} data.csv"`)
    expect(html).toContain('2 KB')
  })
})
