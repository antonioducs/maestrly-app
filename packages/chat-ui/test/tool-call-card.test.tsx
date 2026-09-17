import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ChatUiProvider, ToolCallCard, ResponseDuration, CopyButton, clipOutput, TOOL_OUTPUT_DISPLAY_MAX } from '../src'
import { labels } from './labels'

function Wrap({ children }: { children: ReactNode }) {
  return <ChatUiProvider value={{ labels, openExternal: () => {}, locale: 'en' }}>{children}</ChatUiProvider>
}
const base = { id: 't1', toolName: 'bash', state: 'running' as const }

describe('ToolCallCard', () => {
  it('shows the running state while the tool has not finished', () => {
    expect(renderToStaticMarkup(<Wrap><ToolCallCard part={base} /></Wrap>)).toContain(labels.tool.running)
  })
  it('shows the failure state together with the exit code the tool returned', () => {
    const html = renderToStaticMarkup(<Wrap><ToolCallCard part={{ ...base, state: 'error', exitCode: 2 }} /></Wrap>)
    expect(html).toContain(labels.tool.error)
    expect(html).toContain('data-exit-code')
    expect(html).toContain('>2<')
  })
  it('clips a very long output for display and marks the cut', () => {
    const output = 'x'.repeat(20_000)
    const html = renderToStaticMarkup(<Wrap><ToolCallCard part={{ ...base, state: 'done', output }} defaultOpen /></Wrap>)
    const shown = /data-tool-output[^>]*>([^<]*)</.exec(html)![1]
    expect(shown.startsWith('…')).toBe(true)
    expect(shown.length).toBe(TOOL_OUTPUT_DISPLAY_MAX + 1)
    expect(clipOutput('short')).toBe('short')
  })
})

describe('ResponseDuration and CopyButton', () => {
  it('formats a finished duration in the injected language', () => {
    expect(renderToStaticMarkup(<Wrap><ResponseDuration durationMs={61_000} /></Wrap>)).toContain(labels.responseDuration(61))
    expect(renderToStaticMarkup(<Wrap><ResponseDuration durationMs={61_000} /></Wrap>)).toContain('1m 01s')
    expect(renderToStaticMarkup(<Wrap><ResponseDuration /></Wrap>)).toBe('')
  })
  it('labels the copy button with the injected copy', () => {
    expect(renderToStaticMarkup(<Wrap><CopyButton text="hello" /></Wrap>)).toContain(`aria-label="${labels.copy}"`)
  })
})
