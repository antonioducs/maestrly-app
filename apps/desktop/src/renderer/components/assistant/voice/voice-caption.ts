/**
 * The line the voice screen shows: what the person said, or the sentence the assistant is saying, lit word by word
 * as it is read. Pure: the screen asks it what to show at each moment.
 */

export interface VoiceCaption {
  who: 'you' | 'voice'
  text: string
  /** More words are on their way (a Realtime transcript as it streams). */
  streaming: boolean
  /** A sentence being read: when it started and how long it lasts. */
  startedAt: number
  durationMs: number | null
  /** Where the voice is in the sentence, when it says so (the system's voices do, word by word). */
  charIndex: number | null
}

/** Long enough for a sentence, short enough for three lines in the window. */
export const CAPTION_MAX_WORDS = 28
/** Words already read that stay in view before the one being read. */
const CAPTION_LOOKAHEAD = 8

export interface CaptionView {
  words: string[]
  /** How many of `words` were said already. */
  lit: number
  /** Words before these were left out. */
  clipped: boolean
}

/** Whether the sentence is still being read word by word on a clock: the screen redraws it until it ends. */
export function captionTicking(caption: VoiceCaption | null, now: number): boolean {
  return (
    !!caption &&
    caption.who === 'voice' &&
    !caption.streaming &&
    caption.durationMs !== null &&
    now < caption.startedAt + caption.durationMs
  )
}

export function captionView(caption: VoiceCaption, now: number): CaptionView {
  const spans = [...caption.text.matchAll(/\S+/g)].map((match) => ({ word: match[0], at: match.index }))
  let lit = spans.length
  if (caption.who === 'voice' && !caption.streaming) {
    const reached =
      caption.charIndex ??
      (caption.durationMs
        ? (Math.max(0, now - caption.startedAt) / caption.durationMs) * caption.text.length
        : caption.text.length)
    lit = spans.filter((span) => span.at <= reached).length
  }
  if (spans.length <= CAPTION_MAX_WORDS) return { words: spans.map((span) => span.word), lit, clipped: false }
  // A long one shows where it is: the newest words, or those around the word being read.
  const end =
    lit >= spans.length ? spans.length : Math.min(spans.length, Math.max(CAPTION_MAX_WORDS, lit + CAPTION_LOOKAHEAD))
  const start = end - CAPTION_MAX_WORDS
  return {
    words: spans.slice(start, end).map((span) => span.word),
    lit: Math.max(0, lit - start),
    clipped: start > 0,
  }
}
