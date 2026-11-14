import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSpeaker, estimatedSpeechMs } from '../../src/renderer/components/assistant/voice/speaker'

/** The system's speech, played by the test: it starts, reaches words and ends utterances on demand. */
class FakeUtterance {
  lang = ''
  rate = 1
  voice: unknown = null
  onstart: (() => void) | null = null
  onboundary: ((event: { name: string; charIndex: number }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  constructor(readonly text: string) {}
}

function setup() {
  const spoken: FakeUtterance[] = []
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [],
    speak: (utterance: FakeUtterance) => spoken.push(utterance),
    cancel: vi.fn(),
  })
  const events = { onIdle: vi.fn(), onError: vi.fn(), onSentence: vi.fn(), onBoundary: vi.fn() }
  const speaker = createSpeaker({ engine: 'system', locale: 'pt-BR', systemVoice: null, speed: 1, ...events })
  return { spoken, speaker, ...events }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the system voice, for the voice screen', () => {
  it('says when each sentence starts and which word it reached, and pulses while it talks', () => {
    const { spoken, speaker, onSentence, onBoundary, onIdle } = setup()
    expect(speaker.level()).toBe(0)
    speaker.speak('Três bots rodando.')
    spoken[0].onstart?.()
    expect(onSentence).toHaveBeenCalledWith('Três bots rodando.', estimatedSpeechMs('Três bots rodando.', 1))
    spoken[0].onboundary?.({ name: 'word', charIndex: 5 })
    spoken[0].onboundary?.({ name: 'sentence', charIndex: 0 })
    expect(onBoundary.mock.calls).toEqual([[5]])
    expect(speaker.level()).toBeGreaterThan(0.1)
    spoken[0].onend?.()
    expect(onIdle).toHaveBeenCalledOnce()
    expect(speaker.level()).toBe(0)
  })

  it('ignores a stopped sentence', () => {
    const { spoken, speaker, onSentence, onBoundary } = setup()
    speaker.speak('Primeira frase.')
    speaker.stop()
    spoken[0].onstart?.()
    spoken[0].onboundary?.({ name: 'word', charIndex: 0 })
    expect(onSentence).not.toHaveBeenCalled()
    expect(onBoundary).not.toHaveBeenCalled()
    expect(speaker.level()).toBe(0)
  })

  it('estimates about 15 characters a second, faster with speed', () => {
    expect(estimatedSpeechMs('x'.repeat(30), 1)).toBe(2000)
    expect(estimatedSpeechMs('x'.repeat(30), 2)).toBe(1000)
  })
})
