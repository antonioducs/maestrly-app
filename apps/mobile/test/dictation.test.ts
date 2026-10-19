import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendDictation,
  createDictation,
  createRecordedDictation,
  DICTATION_RECORDING_MAX_MS,
  DICTATION_STOP_GRACE_MS,
  dictationLanguages,
  preferTranscriber,
  recognizerLanguage,
  transcriptionLanguage,
  type DictationState,
  type RecordedTranscription,
  type Recording,
  type RecordingEngine,
  type SpeechEngine,
  type SpeechError,
  type SpeechResult,
  type TranscriberEngine,
} from '../src/dictation/session'

/** Part of the tags Apple's recognizer takes (SFSpeechRecognizer.supportedLocales), in the order it lists them. */
const APPLE = [
  'de-AT',
  'de-DE',
  'en-AE',
  'en-AU',
  'en-GB',
  'en-IN',
  'en-US',
  'es-ES',
  'es-MX',
  'fr-CA',
  'fr-FR',
  'ja-JP',
  'pt-BR',
  'pt-PT',
  'zh-CN',
  'zh-TW',
]

function fakeEngine({ granted = true, available = true, supported = [] as readonly string[] } = {}) {
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
    languages: () => Promise.resolve(supported),
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

/** Apple's SpeechTranscriber: `models` are the languages whose model is on the phone. */
function fakeTranscriber({
  available = true,
  supported = ['en-US', 'pt-BR', 'fr-FR'] as readonly string[],
  models = ['en-US', 'pt-BR'] as readonly string[],
} = {}) {
  const base = fakeEngine({ available, supported })
  const record = base.start
  let release: () => void = () => {}
  const transcriber = Object.assign(base, {
    prepared: [] as string[],
    failStart: false,
    holdStart: false,
    prepare: (lang: string) => {
      transcriber.prepared.push(lang)
      return Promise.resolve(models.includes(lang))
    },
    start: (lang: string) => {
      if (transcriber.failStart) return Promise.reject(new Error('no microphone'))
      record(lang)
      return transcriber.holdStart
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : Promise.resolve()
    },
    release: () => release(),
  })
  return transcriber satisfies TranscriberEngine & Record<string, unknown>
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

  it('wants the language chosen in the app first, in the phone variant of it', () => {
    expect(dictationLanguages(['en-BR', 'pt-BR'], 'pt-BR')).toEqual(['pt-BR', 'en-BR'])
    expect(dictationLanguages(['en-BR'], 'pt-BR')).toEqual(['pt-BR', 'en-BR'])
    expect(dictationLanguages(['pt-BR', 'en-GB'], 'en')).toEqual(['en-GB', 'pt-BR'])
    expect(dictationLanguages(['pt-PT'], 'pt-BR')).toEqual(['pt-PT'])
    expect(dictationLanguages([], 'en')).toEqual(['en-US'])
    expect(dictationLanguages(['', 'not a tag'], 'pt-BR')).toEqual(['pt-BR'])
  })

  it('wants the phone languages in their order when the app follows the system', () => {
    expect(dictationLanguages(['en-BR', 'pt-BR'], 'system')).toEqual(['en-BR', 'pt-BR', 'en-US'])
    expect(dictationLanguages(['pt-BR', 'en-US'], 'system')).toEqual(['pt-BR', 'en-US'])
    expect(dictationLanguages(['fr-FR', 'pt-BR'], 'system')).toEqual(['fr-FR', 'pt-BR'])
    expect(dictationLanguages([], 'system')).toEqual(['en-US'])
  })

  it("listens in the phone's language even when its region has no recognizer", () => {
    // An iPhone in English set to Brazil names its language en-BR, which Apple's recognizer does not list.
    expect(recognizerLanguage(['en-BR', 'pt-BR'], APPLE)).toBe('en-US')
    expect(recognizerLanguage(['en', 'pt-BR'], APPLE)).toBe('en-US')
    expect(recognizerLanguage(['pt-BR', 'en-US'], APPLE)).toBe('pt-BR')
    expect(recognizerLanguage(['pt-PT'], APPLE)).toBe('pt-PT')
    expect(recognizerLanguage(['pt-AO'], APPLE)).toBe('pt-BR')
    expect(recognizerLanguage(['fr-BR'], APPLE)).toBe('fr-FR')
    expect(recognizerLanguage(['ja'], APPLE)).toBe('ja-JP')
    expect(recognizerLanguage(['zh-Hant-TW'], APPLE)).toBe('zh-TW')
    expect(recognizerLanguage(['en_gb'], APPLE)).toBe('en-GB')
  })

  it('moves to the next language only when the recognizer has none of the first', () => {
    expect(recognizerLanguage(['ga-IE', 'pt-BR'], APPLE)).toBe('pt-BR')
    // Then the recognizer itself says it cannot listen.
    expect(recognizerLanguage(['ga-IE'], APPLE)).toBe('ga-IE')
    // A recognizer that takes any tag gets the phone's own.
    expect(recognizerLanguage(['en-BR', 'pt-BR'], [])).toBe('en-BR')
  })

  it('starts the recognizer in a language it takes', async () => {
    const engine = fakeEngine({ supported: APPLE })
    const dictation = createDictation(engine, () => {})
    await dictation.start('en-BR', 'en-US')
    expect(engine.started).toEqual(['en-US'])
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

  it('turns off a recognizer that finishes starting after the dictation was stopped', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber()
    transcriber.holdStart = true
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), () => {})
    const starting = dictation.start('pt-BR')
    await vi.waitFor(() => expect(transcriber.started).toEqual(['pt-BR']))
    dictation.stop()
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    transcriber.release()
    await starting
    expect(transcriber.aborts).toBe(1)
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
  })

  it('says it cannot listen when the recognizer fails to start', async () => {
    const engine = fakeEngine()
    engine.start = () => {
      throw new Error('Speech recognition is not in this build')
    }
    const dictation = createDictation(engine, () => {})
    await dictation.start('en-US')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'unavailable' })
  })
})

describe('dictation with the transcriber', () => {
  it('listens with the transcriber when it has the model of the language', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber()
    const heard: string[] = []
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), (text) => heard.push(text))
    // An iPhone in English set to Brazil: the recognizer's choice, en-US, is what the transcriber is asked for.
    await dictation.start('en-BR', 'pt-BR')
    expect(transcriber.started).toEqual(['en-US'])
    expect(recognizer.started).toEqual([])
    expect(dictation.state()).toEqual({ phase: 'listening', text: '' })

    transcriber.hear('Abra o pull')
    transcriber.hear('Abra o pull request.', true)
    transcriber.hear('Pode ser agora?', true)
    dictation.stop()
    expect(transcriber.stops).toBe(1)
    expect(recognizer.stops).toBe(0)
    transcriber.end()
    expect(heard).toEqual(['Abra o pull request. Pode ser agora?'])
  })

  it('listens with the recognizer while the model downloads, and asks for it again next time', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber({ models: [] })
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), () => {})
    await dictation.start('pt-BR')
    expect(transcriber.prepared).toEqual(['pt-BR'])
    expect(transcriber.started).toEqual([])
    expect(recognizer.started).toEqual(['pt-BR'])
    dictation.cancel()
    await dictation.start('pt-BR')
    expect(transcriber.prepared).toEqual(['pt-BR', 'pt-BR'])
  })

  it('never swaps the variant of a language for one the transcriber has', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber({ supported: ['pt-BR'], models: ['pt-BR'] })
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), () => {})
    await dictation.start('pt-PT')
    expect(transcriber.prepared).toEqual([])
    expect(recognizer.started).toEqual(['pt-PT'])
  })

  it("takes the transcriber's own spelling of a tag", async () => {
    const recognizer = fakeEngine({ supported: ['zh-TW'] })
    const transcriber = fakeTranscriber({ supported: ['zh-Hant_TW'], models: ['zh-Hant_TW'] })
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), () => {})
    await dictation.start('zh-Hant-TW')
    expect(transcriber.started).toEqual(['zh-Hant_TW'])
  })

  it('listens with the recognizer on phones without the transcriber', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber({ available: false })
    const engine = preferTranscriber(transcriber, recognizer)
    expect(engine.available()).toBe(true)
    const dictation = createDictation(engine, () => {})
    await dictation.start('pt-BR')
    expect(transcriber.prepared).toEqual([])
    expect(recognizer.started).toEqual(['pt-BR'])
  })

  it('falls back to the recognizer when the transcriber fails to start', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber()
    transcriber.failStart = true
    const heard: string[] = []
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), (text) => heard.push(text))
    await dictation.start('pt-BR')
    expect(recognizer.started).toEqual(['pt-BR'])
    expect(dictation.state()).toEqual({ phase: 'listening', text: '' })
    recognizer.hear('Rode os testes', true)
    recognizer.end()
    expect(heard).toEqual(['Rode os testes'])
  })

  it('hears only the engine listening', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber()
    const heard: string[] = []
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), (text) => heard.push(text))
    await dictation.start('pt-BR')
    recognizer.hear('stray words', true)
    recognizer.fail('network')
    recognizer.end()
    expect(dictation.state()).toEqual({ phase: 'listening', text: '' })
    transcriber.hear('Tudo certo.', true)
    transcriber.end()
    expect(heard).toEqual(['Tudo certo.'])
    dictation.dispose()
    expect(transcriber.listeners() + recognizer.listeners()).toBe(0)
  })

  it('asks the transcriber for its languages again after it gave none', async () => {
    const recognizer = fakeEngine({ supported: APPLE })
    const transcriber = fakeTranscriber()
    let calls = 0
    transcriber.languages = () => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('not ready')) : Promise.resolve(['pt-BR'])
    }
    const dictation = createDictation(preferTranscriber(transcriber, recognizer), () => {})
    await dictation.start('pt-BR')
    expect(recognizer.started).toEqual(['pt-BR'])
    dictation.cancel()
    await dictation.start('pt-BR')
    expect(transcriber.started).toEqual(['pt-BR'])
    dictation.cancel()
    await dictation.start('pt-BR')
    expect(calls).toBe(2)
  })
})

function fakeRecorder({ granted = true } = {}) {
  let level: ((value: number) => void) | null = null
  const engine = {
    started: 0,
    stops: 0,
    aborts: 0,
    discarded: [] as Recording[],
    calls: [] as Array<[Recording, string | null]>,
    nextRecording: { uri: 'file:///rec-1.m4a', peakDb: -12 } as Recording | null,
    outcomes: [] as Array<RecordedTranscription | Promise<RecordedTranscription>>,
    available: () => true,
    requestPermission: async () => granted,
    async start(onLevel: (value: number) => void) {
      engine.started++
      level = onLevel
    },
    async stop() {
      engine.stops++
      return engine.nextRecording
    },
    abort() {
      engine.aborts++
    },
    async transcribe(recording: Recording, language: string | null) {
      engine.calls.push([recording, language])
      return (await engine.outcomes.shift()) ?? { text: '' }
    },
    discard(recording: Recording) {
      engine.discarded.push(recording)
    },
    emitLevel: (value: number) => level?.(value),
  }
  return engine satisfies RecordingEngine & Record<string, unknown>
}

/** Lets the session's awaited promises settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('recorded dictation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records, sends the recording when stopped and hands its text over', async () => {
    const engine = fakeRecorder()
    engine.outcomes.push({ text: ' olá mundo ' })
    const heard: string[] = []
    const dictation = createRecordedDictation(engine, (text) => heard.push(text))
    const phases: DictationState['phase'][] = []
    dictation.subscribe((state) => phases.push(state.phase))
    await dictation.start('pt-BR', 'en-US')
    expect(dictation.state()).toEqual({ phase: 'listening', text: '', level: 0 })
    dictation.stop()
    await settle()
    expect(phases).toContain('transcribing')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    expect(heard).toEqual(['olá mundo'])
    expect(engine.calls).toEqual([[{ uri: 'file:///rec-1.m4a', peakDb: -12 }, 'pt']])
    expect(engine.discarded).toHaveLength(1)
  })

  it('sends the language part of the first wanted tag, or none', () => {
    expect(transcriptionLanguage(['pt-BR', 'en-US'])).toBe('pt')
    expect(transcriptionLanguage(['zh-Hant-TW'])).toBe('zh')
    expect(transcriptionLanguage([])).toBeNull()
    expect(transcriptionLanguage(['x'])).toBeNull()
  })

  it('does not send a silent recording', async () => {
    const engine = fakeRecorder()
    engine.nextRecording = { uri: 'file:///quiet.m4a', peakDb: -60 }
    const dictation = createRecordedDictation(engine, () => {})
    await dictation.start('en-US')
    dictation.stop()
    await settle()
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'noSpeech' })
    expect(engine.calls).toHaveLength(0)
    expect(engine.discarded).toEqual([{ uri: 'file:///quiet.m4a', peakDb: -60 }])
  })

  it('keeps a recording whose transcription failed and sends it again', async () => {
    const engine = fakeRecorder()
    engine.outcomes.push({ error: 'unavailable' }, { text: 'oi' })
    const heard: string[] = []
    const dictation = createRecordedDictation(engine, (text) => heard.push(text))
    await dictation.start('pt-BR')
    dictation.stop()
    await settle()
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'transcribeFailed', retry: true })
    expect(engine.discarded).toHaveLength(0)
    dictation.retry()
    await settle()
    expect(heard).toEqual(['oi'])
    expect(engine.calls.map(([recording]) => recording.uri)).toEqual(['file:///rec-1.m4a', 'file:///rec-1.m4a'])
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    expect(engine.discarded).toHaveLength(1)
  })

  it('says why the server refused, keeping the recording unless the server has no key', async () => {
    const cases: Array<[RecordedTranscription, DictationState]> = [
      [{ error: 'key-rejected' }, { phase: 'idle', issue: 'keyRejected', retry: true }],
      [{ error: 'busy' }, { phase: 'idle', issue: 'serverBusy', retry: true }],
      [{ error: 'quota' }, { phase: 'idle', issue: 'quota', retry: true }],
      [{ error: 'not-configured' }, { phase: 'idle', issue: 'notConfigured' }],
    ]
    for (const [outcome, state] of cases) {
      const engine = fakeRecorder()
      engine.outcomes.push(outcome)
      const dictation = createRecordedDictation(engine, () => {})
      await dictation.start('en-US')
      dictation.stop()
      await settle()
      expect(dictation.state()).toEqual(state)
      expect(engine.discarded).toHaveLength('error' in outcome && outcome.error === 'not-configured' ? 1 : 0)
    }
  })

  it('drops a transcription cancelled while the server works on it', async () => {
    const engine = fakeRecorder()
    let answer!: (outcome: RecordedTranscription) => void
    engine.outcomes.push(new Promise<RecordedTranscription>((resolve) => (answer = resolve)))
    const heard: string[] = []
    const dictation = createRecordedDictation(engine, (text) => heard.push(text))
    await dictation.start('en-US')
    dictation.stop()
    await settle()
    expect(dictation.state()).toEqual({ phase: 'transcribing' })
    dictation.cancel()
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    answer({ text: 'too late' })
    await settle()
    expect(heard).toEqual([])
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
    expect(engine.discarded).toHaveLength(1)
  })

  it('stops by itself at the length limit', async () => {
    vi.useFakeTimers()
    const engine = fakeRecorder()
    engine.outcomes.push({ text: 'long one' })
    const heard: string[] = []
    const dictation = createRecordedDictation(engine, (text) => heard.push(text))
    await dictation.start('en-US')
    await vi.advanceTimersByTimeAsync(DICTATION_RECORDING_MAX_MS - 1)
    expect(engine.stops).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.stops).toBe(1)
    expect(heard).toEqual(['long one'])
  })

  it('needs the microphone', async () => {
    const engine = fakeRecorder({ granted: false })
    const dictation = createRecordedDictation(engine, () => {})
    await dictation.start('en-US')
    expect(dictation.state()).toEqual({ phase: 'idle', issue: 'denied' })
    expect(engine.started).toBe(0)
  })

  it('throws away a kept recording when a new dictation starts', async () => {
    const engine = fakeRecorder()
    engine.outcomes.push({ error: 'unavailable' })
    const dictation = createRecordedDictation(engine, () => {})
    await dictation.start('en-US')
    dictation.stop()
    await settle()
    expect(engine.discarded).toHaveLength(0)
    engine.nextRecording = { uri: 'file:///rec-2.m4a', peakDb: -10 }
    await dictation.start('en-US')
    expect(engine.discarded).toEqual([{ uri: 'file:///rec-1.m4a', peakDb: -12 }])
    expect(dictation.state().phase).toBe('listening')
  })

  it('reports how loud the recording is', async () => {
    const engine = fakeRecorder()
    const dictation = createRecordedDictation(engine, () => {})
    await dictation.start('en-US')
    engine.emitLevel(0.5)
    expect(dictation.state()).toEqual({ phase: 'listening', text: '', level: 0.5 })
  })

  it('leaves recognizer dictation without anything to retry', async () => {
    const engine = fakeEngine()
    const dictation = createDictation(engine, () => {})
    dictation.retry()
    expect(dictation.state()).toEqual({ phase: 'idle', issue: null })
  })
})
