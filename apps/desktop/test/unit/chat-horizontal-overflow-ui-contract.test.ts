import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const chatViewSource = source('src/renderer/components/chat/ChatView.tsx')
const messageListSource = source('src/renderer/components/chat/ChatMessageList.tsx')
const stylesSource = source('src/renderer/styles.css')
const toolCallCardSource = source('src/renderer/components/chat/ToolCallCard.tsx')
const subagentCardSource = source('src/renderer/components/chat/SubagentCard.tsx')

describe('chat horizontal scrolling contract without a global scrollbar', () => {
  it('restricts main conversation scrolling to vertical', () => {
    expect(chatViewSource).toContain('min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden')
  })

  it('allows message columns to shrink below content width', () => {
    // px-3 aligns with the composer's outer padding (ChatComposer outer wrapper).
    expect(messageListSource).toContain('chat-msgs mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 px-3 py-5')
    // Message wrappers and roots must not impose minimum widths.
    expect(messageListSource).toContain("'min-w-0 max-w-full scroll-mt-16 rounded-xl transition-shadow'")
    expect(messageListSource).toContain('group flex w-full min-w-0 max-w-full flex-col gap-1')
    expect(messageListSource).toContain('group flex w-full min-w-0 max-w-full flex-col gap-2.5')
  })

  it('preserves max-w-3xl against percentage width overrides', () => {
    // Unlayered CSS after the Tailwind import overrides utilities: max-width:100% on the root
    // overrode max-w-3xl, making the conversation full width and misaligned with the composer.
    expect(stylesSource).toMatch(/\.chat-msgs\s*\{[^}]*min-width:\s*0[^}]*\}/)
    expect(stylesSource).not.toMatch(/\.chat-msgs\s*,\s*\n?\s*\.chat-msgs\s*>\s*\*/)
    const rootBlock = stylesSource.match(/\.chat-msgs\s*\{[^}]+\}/)?.[0] ?? ''
    expect(rootBlock).not.toMatch(/max-width/)
  })

  it('wraps long text within chat markdown scope', () => {
    expect(stylesSource).toMatch(/\.chat-msgs \.dark-glass-prose \{[^}]*overflow-wrap: anywhere/s)
    expect(stylesSource).toMatch(/\.chat-msgs \.dark-glass-prose :not\(pre\) > code \{[^}]*overflow-wrap: anywhere/s)
  })

  it('preserves local horizontal scrolling in code and tables', () => {
    expect(stylesSource).toMatch(/\.chat-msgs \.dark-glass-prose pre,[\s\S]*?overflow-x: auto/)
    expect(stylesSource).toMatch(/\.chat-msgs \.dark-glass-prose table[\s\S]*?overflow-x: auto/)
    expect(stylesSource).toMatch(/\.chat-msgs \.dark-glass-prose pre,[\s\S]*?overflow-wrap: normal/)
  })

  it('prevents tool and subagent cards from widening conversations', () => {
    expect(toolCallCardSource).toContain('min-w-0 max-w-full rounded-lg border border-border')
    expect(subagentCardSource).toContain('min-w-0 max-w-full rounded-lg border border-violet-500/20')
  })
})
