import { describe, expect, it, vi } from 'vitest'
import { scrollChatSearchResult } from '../../src/renderer/lib/chat-search-scroll'

interface Match {
  id: string
  revealed: boolean
  scrollIntoView: ReturnType<typeof vi.fn<(options: { block: 'center'; behavior: 'auto' }) => void>>
}

function match(id: string, revealed: boolean): Match {
  return { id, revealed, scrollIntoView: vi.fn() }
}

const isRevealed = (item: Match) => item.revealed
const scrollOptions = { block: 'center', behavior: 'auto' }

describe('scrollChatSearchResult', () => {
  it('centers the first revealed current occurrence', () => {
    const hidden = match('current-hidden', false)
    const current = match('current-visible', true)
    const later = match('current-later', true)
    const fallback = match('message', true)

    expect(scrollChatSearchResult([hidden, current, later], [], fallback, isRevealed)).toBe(current)
    expect(current.scrollIntoView).toHaveBeenCalledWith(scrollOptions)
    expect(later.scrollIntoView).not.toHaveBeenCalled()
    expect(fallback.scrollIntoView).not.toHaveBeenCalled()
  })

  it('centers the first revealed generic occurrence before the current class mounts', () => {
    const hidden = match('hidden', false)
    const visible = match('visible', true)
    const fallback = match('message', true)

    expect(scrollChatSearchResult([], [hidden, visible], fallback, isRevealed)).toBe(visible)
    expect(visible.scrollIntoView).toHaveBeenCalledWith(scrollOptions)
    expect(fallback.scrollIntoView).not.toHaveBeenCalled()
  })

  it('centers the wrapper when all highlights are collapsed or absent', () => {
    const hidden = match('hidden', false)
    const fallback = match('message', true)

    expect(scrollChatSearchResult([hidden], [hidden], fallback, isRevealed)).toBe(fallback)
    expect(hidden.scrollIntoView).not.toHaveBeenCalled()
    expect(fallback.scrollIntoView).toHaveBeenCalledWith(scrollOptions)
  })
})
