import { describe, expect, it } from 'vitest'
import {
  CAPTION_MAX_WORDS,
  captionTicking,
  captionView,
  type VoiceCaption,
} from '../../src/renderer/components/assistant/voice/voice-caption'

const caption = (patch: Partial<VoiceCaption>): VoiceCaption => ({
  who: 'voice',
  text: 'Três bots estão rodando agora.',
  streaming: false,
  startedAt: 1000,
  durationMs: 2000,
  charIndex: null,
  ...patch,
})

describe('the voice screen caption', () => {
  it('shows what the person said all at once', () => {
    expect(captionView(caption({ who: 'you', text: 'Como estão meus bots?' }), 0)).toEqual({
      words: ['Como', 'estão', 'meus', 'bots?'],
      lit: 4,
      clipped: false,
    })
  })

  it('lights the sentence as the voice reads it, on a clock without word marks', () => {
    const c = caption({})
    expect(captionView(c, 1000).lit).toBe(1)
    expect(captionView(c, 2000).lit).toBe(3)
    expect(captionView(c, 3000).lit).toBe(5)
    expect(captionTicking(c, 2999)).toBe(true)
    expect(captionTicking(c, 3000)).toBe(false)
  })

  it('follows the word the system voice reports over the clock', () => {
    // "estão" starts at 10; the clock alone would already be at the end.
    expect(captionView(caption({ charIndex: 10 }), 9000).lit).toBe(3)
    expect(captionTicking(caption({ who: 'you' }), 1500)).toBe(false)
  })

  it('shows a streaming transcript as it arrives', () => {
    expect(captionView(caption({ streaming: true, text: 'Três bots' }), 1000).lit).toBe(2)
    expect(captionTicking(caption({ streaming: true }), 1500)).toBe(false)
  })

  it('keeps a long caption to its newest words, or to those around the word being read', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`)
    const long = caption({ who: 'you', text: words.join(' ') })
    const tail = captionView(long, 0)
    expect(tail.words).toHaveLength(CAPTION_MAX_WORDS)
    expect(tail.words.at(-1)).toBe('w39')
    expect(tail).toMatchObject({ lit: CAPTION_MAX_WORDS, clipped: true })

    const reading = captionView(
      caption({ text: words.join(' '), charIndex: words.slice(0, 30).join(' ').length + 1 }),
      0
    )
    // 31 words read: the window ends 8 words past them.
    expect(reading.words.at(-1)).toBe('w38')
    expect(reading.words[reading.lit - 1]).toBe('w30')

    const start = captionView(caption({ text: words.join(' '), charIndex: 0 }), 0)
    expect(start).toMatchObject({ lit: 1, clipped: false })
    expect(start.words[0]).toBe('w0')
  })
})
