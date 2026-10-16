import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendDictation,
  createDictation,
  DICTATION_STOP_GRACE_MS,
  dictationLanguage,
  type SpeechEngine,
  type SpeechError,
  type SpeechResult,
} from '../src/dictation/session'

function fakeEngine({ granted = true, available = true } = {}) {
  const results = new Set<(result: SpeechResult) => void>()
  const errors = new Set<(error: SpeechError) => void>()
  const ends = new Set<() => void>()
  let permission: (value: boolean) => void = () => {}
  const engine = {
    started: [] as string[],
    stops: 0,
    aborts: 0,
    holdPermission: false,
    available: () => available,
    requestPermission: () =>
      engine.holdPermission
        ? new Promise<boolean>((resolve) => {
            permission = resolve
          })
        : Promise.resolve(granted),
    start: (lang: string) => {
      engine.started.push(lang)
    },
    stop: () => {
      engine.stops += 1
    },
    abort: () => {
      engine.aborts += 1
    },
    onResult: (listener: (result: SpeechResult) => void) => {
      results.add(listener)
      return () => results.delete(listener)
    },
    onError: (listener: (error: SpeechError) => void) => {
      errors.add(listener)
      return () => errors.delete(listener)
    },
    onEnd: (listener: () => void) => {
      ends.add(listener)
      return () => ends.delete(listener)
    },
    hear: (transcript: string, final = false) => {
      for (const listener of results) listener({ transcript, final })
    },
    fail: (error: SpeechError) => {
      for (const listener of errors) listener(error)
    },
    end: () => {
      for (const listener of ends) listener()
    },
    grant: (value: boolean) => permission(value),
    listeners: () => results.size + errors.size + ends.size,
  }
  return engine satisfies SpeechEngine & Record<string, unknown>
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dictation', () => {
  it('adds what was heard to the field with one space, and leaves an empty dictation out', () => {
    expect(appendDictation('', ' Ship it ')).toBe('Ship it')
    expect(appendDictation('Also', 'run the tests')).toBe('Also run the tests')
    expect(appendDictation('Also ', 'run the tests')).toBe('Also run the tests')
    expect(appendDictation('Also\n', 'run the tests')).toBe('Also\nrun the tests')
    expect(appendDictation('Keep this', '  ')).toBe('Keep this')
    expect(appendDictation('  ', 'Hello')).toBe('Hello')
  })

  it('listens in the phone language first, else in the app language', () => {
    expect(dictationLanguage(['pt-BR', 'en-US'], 'en')).toBe('pt-BR')
    expect(dictationLanguage(['en-GB'], 'pt-BR')).toBe('en-GB')
    expect(dictationLanguage([], 'pt-BR')).toBe('pt-BR')
    expect(dictationLanguage(['', 'not a tag'], 'en')).toBe('en-US')
  })

  it('shows the words as they are heard and hands them over when listening ends', async () => {
    const engine = fakeEngine()
    const heard: string[] = []
    const dictation = createDictation(engine, (text) => heard.push(text))
    const states: string[] = []
    dictation.subscribe((state) => states.push(state.phase === 'listening' ? `listening:${state.text}` : state.phase))

    await dictation.start('en-US')
    expect(engine.started).toEqual(['en-US'])
    engine.hear('Also run')
    engine.hear('Also run the smoke tests')
    engine.hear('Also run the smoke tests.', true)
    dictation.stop()
    expect(engine.stops).toBe(1)
    engine.end()

    expect(states).toEqual([
      'starting',
      'listening:',
      'listening:Also run',
      'listening:Also run the smoke tests',
      'listening:Also run the smoke tests.',
      'idle',
    ])
    expect(heard).toEqual(['Also run the smoke tests.'])
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
  })

  it('adds up phrases a recognizer fixes one by one, with the latest guess after them', async () => {
    const engine = fakeEngine()
    const heard: string[] = []
    const dictation = createDictation(engine, (text) => heard.push(text))
    await dictation.start('pt-BR')
    engine.hear('Rode os testes.', true)
    engine.hear('Depois')
    expect(dictation.state()).toEqual({ phase: 'listening', text: 'Rode os testes. Depois' })
    engine.hear('Depois abra o PR.', true)
    engine.end()
    expect(heard).toEqual(['Rode os testes. Depois abra o PR.'])
  })

  it('drops what was heard when cancelled, even if the recognizer stays quiet', async () => {
    const engine = fakeEngine()
    const heard: string[] = []
    const dictation = createDictation(engine, (text) => heard.push(text))
    await dictation.start('en-US')
    engine.hear('never mind')
    dictation.cancel()
    expect(engine.aborts).toBe(1)
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    engine.fail('aborted')
    engine.end()
    expect(heard).toEqual([])
  })

  it('says why it could not listen, and keeps the words heard before an error', async () => {
    const denied = createDictation(fakeEngine({ granted: false }), () => {})
    await denied.start('en-US')
    expect(denied.state()).toEqual({ phase: 'idle', issue: 'denied' })

    const engine = fakeEngine()
    const heard: string[] = []
    const dictation = createDictation(engine, (text) => heard.push(text))
    await dictation.start('en-US')
    engine.fail('no-speech')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'noSpeech' })

    await dictation.start('en-US')
    engine.hear('half a')
    engine.fail('network')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'network' })
    expect(heard).toEqual(['half a'])

    await dictation.start('en-US')
    engine.hear('before the call')
    engine.fail('interrupted')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    expect(heard).toEqual(['half a', 'before the call'])

    await dictation.start('en-US')
    engine.fail('client')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'failed' })
  })

  it('does not start when stopped while the permission prompt is up', async () => {
    const engine = fakeEngine()
    engine.holdPermission = true
    const dictation = createDictation(engine, () => {})
    const starting = dictation.start('en-US')
    expect(dictation.state().phase).toBe('starting')
    dictation.stop()
    engine.grant(true)
    await starting
    expect(engine.started).toEqual([])
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
  })

  it('ends with the words it has when a stopped recognizer never finishes', async () => {
    vi.useFakeTimers()
    const engine = fakeEngine()
    const heard: string[] = []
    const dictation = createDictation(engine, (text) => heard.push(text))
    await dictation.start('en-US')
    engine.hear('almost there')
    dictation.stop()
    vi.advanceTimersByTime(DICTATION_STOP_GRACE_MS - 1)
    expect(dictation.state().phase).toBe('listening')
    vi.advanceTimersByTime(1)
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    expect(heard).toEqual(['almost there'])
    engine.end()
    expect(heard).toEqual(['almost there'])
  })

  it('lets go of the recognizer when the composer goes away', async () => {
    const engine = fakeEngine()
    const heard: string[] = []
    const dictation = createDictation(engine, (text) => heard.push(text))
    await dictation.start('en-US')
    engine.hear('left the screen')
    dictation.dispose()
    expect(engine.aborts).toBe(1)
    expect(engine.listeners()).toBe(0)
    expect(heard).toEqual([])
  })
})
