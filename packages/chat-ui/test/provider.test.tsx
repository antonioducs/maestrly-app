import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatUiProvider, useChatUi } from '../src'
import { labels } from './labels'
function Probe() {
  return <span>{useChatUi().labels.copy}</span>
}
describe('ChatUiProvider', () => {
  it('hands the injected copy to descendants and refuses to render without a provider', () => {
    expect(
      renderToStaticMarkup(
        <ChatUiProvider value={{ labels, openExternal: () => {}, locale: 'en' }}>
          <Probe />
        </ChatUiProvider>
      )
    ).toContain('Copy')
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/ChatUiProvider is required/)
  })
})
