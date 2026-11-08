/**
 * The assistant's voice, tap to talk: listen until the person stops, transcribe, send, then read the answer aloud
 * sentence by sentence while it streams. A tap stops the reading (the turn goes on in writing) and Esc stops it all.
 * Pure: the session hook runs the effects.
 */
import type { SupportedLocale } from '../../../../shared/locale'
import { SentenceChunker, toSpeakable } from '../../../../shared/speakable'

/** Marks a message the person spoke, as dictation does. */
export const VOICE_MARKER = '🎙 '

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export type VoiceEvent =
  | { type: 'tap' }
  | { type: 'speech-end' }
  | { type: 'no-speech' }
  | { type: 'mic-failed' }
  | { type: 'transcribed'; text: string }
  | { type: 'transcribe-failed'; error: string }
  | { type: 'reply-delta'; text: string }
  | { type: 'turn-ended' }
  | { type: 'speech-queue-empty' }
  | { type: 'speech-failed'; error: string }
  | { type: 'escape' }

export type VoiceEffect =
  | 'start-mic'
  | 'stop-mic'
  | 'cancel-mic'
  | 'stop-speaking'
  | { submit: string }
  | { speak: string }
  | { notice: string }

export interface VoiceMachine {
  state: VoiceState
  locale: SupportedLocale
  autoSpeak: boolean
  /** The answer's Markdown after the last block already read, and how many of its sentences were read. */
  pending: string
  pendingSpoken: number
  lastSpoken: string | null
  /** The turn ended while its last sentences are still being read. */
  turnEnded: boolean
  /** Reading failed this turn: the rest of the answer stays in the chat. */
  muted: boolean
}

export function createVoiceMachine(opts: { locale: SupportedLocale; autoSpeak: boolean }): VoiceMachine {
  return { state: 'idle', ...opts, pending: '', pendingSpoken: 0, lastSpoken: null, turnEnded: false, muted: false }
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})/

/**
 * Where the complete blocks of streamed Markdown end: after its last blank line or closing fence outside a code
 * block (0 when none), and whether the text after it is inside an open fence.
 */
function completeBlocks(text: string): { end: number; openFence: boolean } {
  let fence: string | null = null
  let end = 0
  let offset = 0
  const lines = text.split('\n')
  // The last line has no newline yet: it may still grow.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    offset += line.length + 1
    if (fence) {
      if (line.trim().startsWith(fence)) {
        fence = null
        end = offset
      }
      continue
    }
    const open = FENCE_LINE.exec(line)
    if (open) fence = open[1]
    else if (!line.trim()) end = offset
  }
  if (!fence && FENCE_LINE.test(lines[lines.length - 1])) return { end, openFence: true }
  return { end, openFence: fence !== null }
}

function sentencesOf(markdown: string, locale: SupportedLocale, complete: boolean): string[] {
  const chunker = new SentenceChunker()
  if (complete) return [...chunker.push(toSpeakable(markdown, locale)), ...chunker.flush()]
  // toSpeakable trims; the space after a period that streamed already closes its sentence.
  return chunker.push(toSpeakable(markdown, locale) + (/\s$/.test(markdown) ? ' ' : ''))
}

/** The sentences of the answer ready to be read after `delta`; `final` reads all that is left. */
function takeSentences(m: VoiceMachine, delta: string, final: boolean): { next: VoiceMachine; sentences: string[] } {
  let pending = m.pending + delta
  let spoken = m.pendingSpoken
  const ready: string[] = []
  const { end, openFence } = final ? { end: pending.length, openFence: false } : completeBlocks(pending)
  if (end > 0) {
    ready.push(...sentencesOf(pending.slice(0, end), m.locale, true).slice(spoken))
    pending = pending.slice(end)
    spoken = 0
  }
  // A paragraph still streaming is read sentence by sentence; code and tables wait until they are whole.
  if (!final && pending.trim() && !openFence && !pending.includes('|')) {
    const tail = sentencesOf(pending, m.locale, false)
    ready.push(...tail.slice(spoken))
    spoken = Math.max(spoken, tail.length)
  }
  const sentences: string[] = []
  let last = m.lastSpoken
  for (const sentence of ready) {
    if (sentence !== last) sentences.push(sentence)
    last = sentence
  }
  return { next: { ...m, pending, pendingSpoken: spoken, lastSpoken: last }, sentences }
}

function reset(m: VoiceMachine, state: VoiceState): VoiceMachine {
  return { ...m, state, pending: '', pendingSpoken: 0, lastSpoken: null, turnEnded: false, muted: false }
}

const speakAll = (sentences: string[]): VoiceEffect[] => sentences.map((sentence) => ({ speak: sentence }))

export function voiceReducer(m: VoiceMachine, event: VoiceEvent): { next: VoiceMachine; effects: VoiceEffect[] } {
  const stay = { next: m, effects: [] as VoiceEffect[] }
  const following = m.state === 'thinking' || m.state === 'speaking'
  switch (event.type) {
    case 'escape':
      return m.state === 'idle' ? stay : { next: reset(m, 'idle'), effects: ['cancel-mic', 'stop-speaking'] }
    case 'tap':
      if (m.state === 'idle' || m.state === 'error') return { next: reset(m, 'listening'), effects: ['start-mic'] }
      if (m.state === 'listening') return { next: { ...m, state: 'transcribing' }, effects: ['stop-mic'] }
      if (following) return { next: reset(m, 'idle'), effects: ['stop-speaking'] }
      return stay
    case 'speech-end':
      return m.state === 'listening' ? { next: { ...m, state: 'transcribing' }, effects: ['stop-mic'] } : stay
    case 'no-speech':
      return m.state === 'listening'
        ? { next: reset(m, 'idle'), effects: ['cancel-mic', { notice: 'no-speech' }] }
        : stay
    case 'mic-failed':
      return m.state === 'listening' ? { next: reset(m, 'error'), effects: ['cancel-mic', { notice: 'mic' }] } : stay
    case 'transcribed': {
      if (m.state !== 'transcribing') return stay
      const text = event.text.trim()
      if (!text) return { next: reset(m, 'idle'), effects: [{ notice: 'no-speech' }] }
      return { next: reset(m, 'thinking'), effects: [{ submit: VOICE_MARKER + text }] }
    }
    case 'transcribe-failed':
      if (m.state !== 'transcribing') return stay
      if (event.error === 'silent') return { next: reset(m, 'idle'), effects: [{ notice: 'no-speech' }] }
      return { next: reset(m, 'error'), effects: [{ notice: `transcribe-${event.error}` }] }
    case 'reply-delta': {
      if (!following || !m.autoSpeak || m.muted) return stay
      const { next, sentences } = takeSentences(m, event.text, false)
      if (!sentences.length) return { next, effects: [] }
      return { next: { ...next, state: 'speaking' }, effects: speakAll(sentences) }
    }
    case 'turn-ended': {
      if (!following) return stay
      const { next, sentences } = m.autoSpeak && !m.muted ? takeSentences(m, '', true) : { next: m, sentences: [] }
      if (!sentences.length && m.state === 'thinking') return { next: reset(m, 'idle'), effects: [] }
      return {
        next: { ...next, state: 'speaking', turnEnded: true, pending: '', pendingSpoken: 0 },
        effects: speakAll(sentences),
      }
    }
    case 'speech-queue-empty':
      if (m.state !== 'speaking') return stay
      return m.turnEnded ? { next: reset(m, 'idle'), effects: [] } : { next: { ...m, state: 'thinking' }, effects: [] }
    case 'speech-failed': {
      if (!following) return stay
      const next = m.turnEnded ? reset(m, 'idle') : { ...m, state: 'thinking' as const, muted: true }
      return { next, effects: ['stop-speaking', { notice: `speech-${event.error}` }] }
    }
  }
}
