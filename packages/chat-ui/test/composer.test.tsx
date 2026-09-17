import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ChatUiProvider, ChatContextMeter, BotPermModePicker, ChatModelChip, ChatReasoningPicker, ChatSkillsMenu, ChatPlusMenu } from '../src'
import { labels } from './labels'

function Wrap({ children }: { children: ReactNode }) {
  return <ChatUiProvider value={{ labels, openExternal: () => {}, locale: 'en' }}>{children}</ChatUiProvider>
}

describe('ChatContextMeter', () => {
  it('shows the occupancy against the window and the percentage', () => {
    const html = renderToStaticMarkup(<Wrap><ChatContextMeter usage={{ input: 0, output: 0, contextInput: 50_000 }} meta={{ contextWindow: 200_000 }} /></Wrap>)
    expect(html).toContain(labels.context.used('50.0k', '200k'))
    expect(html).toContain('50.0k/200k 25%')
  })
  it('says the window is unknown when no metadata exists, and hides itself with nothing used', () => {
    expect(renderToStaticMarkup(<Wrap><ChatContextMeter usage={{ input: 10, output: 5 }} meta={null} /></Wrap>)).toContain(labels.context.unknownWindow)
    expect(renderToStaticMarkup(<Wrap><ChatContextMeter usage={null} meta={{ contextWindow: 1 }} /></Wrap>)).toBe('')
  })
  it('appends the accumulated cost when the caller could price it', () => {
    expect(renderToStaticMarkup(<Wrap><ChatContextMeter usage={{ input: 10, output: 5 }} meta={null} cost={0.5} /></Wrap>)).toContain('~$0.500')
  })
})

describe('pickers', () => {
  it('renders the permission picker disabled with the reason instead of reacting', () => {
    const html = renderToStaticMarkup(<Wrap><BotPermModePicker value="ask" onChange={() => {}} disabled disabledReason="busy" /></Wrap>)
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="busy"')
    expect(html).toContain(labels.permission.ask)
  })
  it('labels the model chip with the chosen model or the title when nothing is chosen', () => {
    const models = [{ id: 'gpt-5', displayName: 'GPT-5', efforts: ['low', 'high'] }]
    expect(renderToStaticMarkup(<Wrap><ChatModelChip models={models} value={{ model: 'gpt-5' }} onChange={() => {}} /></Wrap>)).toContain('GPT-5')
    expect(renderToStaticMarkup(<Wrap><ChatModelChip models={models} value={null} onChange={() => {}} /></Wrap>)).toContain(labels.model.title)
  })
  it('renders the effort picker, the skills counter and the plus menu trigger', () => {
    expect(renderToStaticMarkup(<Wrap><ChatReasoningPicker efforts={['low']} value="low" onChange={() => {}} /></Wrap>)).toContain('low')
    expect(renderToStaticMarkup(<Wrap><ChatSkillsMenu skills={[{ name: 'review', description: '', enabled: true }, { name: 'x', description: '', enabled: false }]} onToggle={() => {}} /></Wrap>)).toContain('>1<')
    expect(renderToStaticMarkup(<Wrap><ChatPlusMenu items={[{ id: 'a', label: 'Attach', onSelect: () => {} }]} /></Wrap>)).toContain('data-plus-menu')
  })
})
