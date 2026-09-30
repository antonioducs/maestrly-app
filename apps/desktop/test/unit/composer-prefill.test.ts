import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPOSER_DRAFT_EVENT,
  clearComposerPrefill,
  offerComposerDraft,
  peekComposerPrefill,
  setComposerPrefill,
  takeComposerDraft,
} from '../../src/renderer/lib/composer-prefill'

// Unit tests run in Node: an event target stands in for the renderer's window.
beforeEach(() => vi.stubGlobal('window', new EventTarget()))
afterEach(() => {
  vi.unstubAllGlobals()
  clearComposerPrefill('c1')
  clearComposerPrefill('c2')
})

describe('composer prefill', () => {
  it('keeps the text until it is cleared, however often it is read', () => {
    setComposerPrefill('c1', 'Build a page')
    expect(peekComposerPrefill('c1')).toBe('Build a page')
    expect(peekComposerPrefill('c1')).toBe('Build a page')
    expect(peekComposerPrefill('c2')).toBeUndefined()
    clearComposerPrefill('c1')
    expect(peekComposerPrefill('c1')).toBeUndefined()
  })

  it('offers a draft to a conversation: stores it and tells the conversation, if it is listening', () => {
    const heard = vi.fn()
    const listener = (event: Event) => heard((event as CustomEvent<{ conversationId: string }>).detail)
    window.addEventListener(COMPOSER_DRAFT_EVENT, listener)
    try {
      offerComposerDraft('c1', 'Comments to consider')
      expect(heard).toHaveBeenCalledWith({ conversationId: 'c1' })
      expect(peekComposerPrefill('c1')).toBe('Comments to consider')
      expect(peekComposerPrefill('c1')).toBe('Comments to consider')
    } finally {
      window.removeEventListener(COMPOSER_DRAFT_EVENT, listener)
    }
  })

  it('adds an offered draft after what is already written, once', () => {
    offerComposerDraft('c1', 'Comments to consider')
    expect(takeComposerDraft('c1', 'Half a sentence')).toBe('Half a sentence\n\nComments to consider')
    expect(peekComposerPrefill('c1')).toBeUndefined()
    // Nothing offered: what is written stays as it is.
    expect(takeComposerDraft('c1', 'Half a sentence')).toBe('Half a sentence')

    offerComposerDraft('c2', 'Comments to consider')
    expect(takeComposerDraft('c2', '  \n')).toBe('Comments to consider')
  })
})
