import { describe, expect, it } from 'vitest'
import { tFor } from '../../src/shared/i18n'
import {
  createVoiceMachine,
  questionPrompt,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceMachine,
  type VoiceState,
  voiceReducer,
} from '../../src/renderer/components/assistant/voice/voice-machine'

/** Runs `events` from a fresh machine; returns where it ended and every effect, in order. */
function run(events: VoiceEvent[], start: Partial<VoiceMachine> = {}) {
  let machine: VoiceMachine = { ...createVoiceMachine({ locale: 'pt-BR', autoSpeak: true }), ...start }
  const effects: VoiceEffect[] = []
  const states: VoiceState[] = []
  for (const event of events) {
    const out = voiceReducer(machine, event)
    machine = out.next
    effects.push(...out.effects)
    states.push(machine.state)
  }
  return { machine, effects, states }
}

const spoken = (effects: VoiceEffect[]) =>
  effects.flatMap((effect) => (typeof effect === 'object' && 'speak' in effect ? [effect.speak] : []))
const delta = (text: string): VoiceEvent => ({ type: 'reply-delta', text })
const asked: VoiceEvent[] = [
  { type: 'tap' },
  { type: 'speech-end' },
  { type: 'transcribed', text: ' como estão as coisas? ' },
]

describe('voice machine', () => {
  it('listens, sends what it heard and reads the answer sentence by sentence', () => {
    const { machine, effects, states } = run([
      ...asked,
      delta('Tudo certo por aqui. Dois testes '),
      delta('falharam no build.\n\n```ts\nconst a = 1\n```\n\nO resto passou'),
      { type: 'turn-ended' },
      { type: 'speech-queue-empty' },
    ])
    expect(states).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'speaking', 'speaking', 'idle'])
    expect(effects.slice(0, 3)).toEqual(['start-mic', 'stop-mic', { submit: '🎙 como estão as coisas?' }])
    expect(spoken(effects)).toEqual([
      'Tudo certo por aqui.',
      'Dois testes falharam no build.',
      '(código no chat)',
      'O resto passou',
    ])
    expect(machine).toMatchObject({ state: 'idle', pending: '', turnEnded: false })
  })

  it('reads the first sentence before the turn ends, and goes back to thinking between sentences', () => {
    const { effects, states } = run([...asked, delta('Vou olhar os logs agora. Um'), { type: 'speech-queue-empty' }])
    expect(spoken(effects)).toEqual(['Vou olhar os logs agora.'])
    expect(states.slice(-2)).toEqual(['speaking', 'thinking'])
  })

  it('waits for a code block or a table to be whole before reading it', () => {
    const { effects } = run([
      ...asked,
      delta('Aqui está a tabela de resultados:\n\n| a | b |\n|---|---|\n'),
      delta('| 1 | 2 |\n\n```bash\nnpm test. Agora'),
      delta(' mais\n```\n\nFim do relatório.'),
      { type: 'turn-ended' },
    ])
    expect(spoken(effects)).toEqual([
      'Aqui está a tabela de resultados:',
      '(tabela no chat)',
      '(código no chat)',
      'Fim do relatório.',
    ])
  })

  it('stops reading on a tap; the turn goes on in writing and later deltas are not read', () => {
    const { machine, effects } = run([
      ...asked,
      delta('Primeira frase do relatório. '),
      { type: 'tap' },
      delta('Segunda frase do relatório. '),
      { type: 'turn-ended' },
    ])
    expect(spoken(effects)).toEqual(['Primeira frase do relatório.'])
    expect(effects).toContain('stop-speaking')
    expect(machine.state).toBe('idle')
  })

  it('ends listening at once on a tap', () => {
    const { effects, states } = run([{ type: 'tap' }, { type: 'tap' }, { type: 'speech-end' }])
    expect(states).toEqual(['listening', 'transcribing', 'transcribing'])
    expect(effects).toEqual(['start-mic', 'stop-mic'])
  })

  it('says it heard nothing when nobody spoke or the transcript is empty', () => {
    for (const events of [
      [{ type: 'tap' }, { type: 'no-speech' }],
      [{ type: 'tap' }, { type: 'speech-end' }, { type: 'transcribed', text: '  ' }],
      [{ type: 'tap' }, { type: 'speech-end' }, { type: 'transcribe-failed', error: 'silent' }],
    ] as VoiceEvent[][]) {
      const { machine, effects } = run(events)
      expect(machine.state).toBe('idle')
      expect(effects).toContainEqual({ notice: 'no-speech' })
      expect(effects.some((effect) => typeof effect === 'object' && 'submit' in effect)).toBe(false)
    }
  })

  it('shows a failed transcription and listens again on the next tap', () => {
    const failed = run([{ type: 'tap' }, { type: 'speech-end' }, { type: 'transcribe-failed', error: 'key-missing' }])
    expect(failed.machine.state).toBe('error')
    expect(failed.effects).toContainEqual({ notice: 'transcribe-key-missing' })
    expect(voiceReducer(failed.machine, { type: 'tap' })).toEqual({
      next: expect.objectContaining({ state: 'listening' }),
      effects: ['start-mic'],
    })
    expect(run([{ type: 'tap' }, { type: 'mic-failed' }]).effects).toEqual([
      'start-mic',
      'cancel-mic',
      { notice: 'mic' },
    ])
  })

  it('stops everything on escape from every state, and does nothing when idle', () => {
    const reach: Record<VoiceState, VoiceEvent[]> = {
      idle: [],
      listening: [{ type: 'tap' }],
      transcribing: [{ type: 'tap' }, { type: 'speech-end' }],
      thinking: asked,
      speaking: [...asked, delta('Uma frase completa aqui. ')],
      error: [{ type: 'tap' }, { type: 'speech-end' }, { type: 'transcribe-failed', error: 'unavailable' }],
    }
    for (const [state, events] of Object.entries(reach)) {
      const before = run(events).machine
      expect(before.state, state).toBe(state)
      const { next, effects } = voiceReducer(before, { type: 'escape' })
      expect(next.state, state).toBe('idle')
      expect(effects, state).toEqual(state === 'idle' ? [] : ['cancel-mic', 'stop-speaking'])
    }
  })

  it('ignores answer deltas before it sends, and while transcribing', () => {
    const { effects, machine } = run([
      delta('Uma frase de outro turno. '),
      { type: 'tap' },
      delta('Outra frase de outro turno. '),
      { type: 'speech-end' },
      delta('Mais uma frase antiga aqui. '),
      { type: 'transcribed', text: 'oi' },
      delta('Resposta nova aqui. '),
    ])
    expect(spoken(effects)).toEqual(['Resposta nova aqui.'])
    expect(machine.state).toBe('speaking')
  })

  it('keeps the answer in the chat when reading fails, until the turn ends', () => {
    const { effects, machine } = run([
      ...asked,
      delta('Primeira frase do relatório. '),
      { type: 'speech-failed', error: 'key-missing' },
      delta('Segunda frase do relatório. '),
      { type: 'turn-ended' },
    ])
    expect(spoken(effects)).toEqual(['Primeira frase do relatório.'])
    expect(effects).toContainEqual({ notice: 'speech-key-missing' })
    expect(machine.state).toBe('idle')
  })

  it('does not read when automatic reading is off', () => {
    const { effects, states } = run([...asked, delta('Uma frase completa aqui. '), { type: 'turn-ended' }], {
      autoSpeak: false,
    })
    expect(spoken(effects)).toEqual([])
    expect(states.at(-1)).toBe('idle')
  })
})

describe('answering a card by voice', () => {
  const card: VoiceEvent = {
    type: 'question',
    toolCallId: 'call-1',
    speech: 'Mandar isto para “Deploy”? Diga Mandar ou Cancelar.',
    retry: 'Não entendi. Toque numa opção.',
    options: ['Mandar', 'Cancelar'],
    answerable: true,
  }
  const heard = (text: string): VoiceEvent[] => [
    { type: 'speech-queue-empty' },
    { type: 'speech-end' },
    { type: 'transcribed', text },
  ]

  it('reads the card, listens once and answers with the option said', () => {
    const { machine, effects, states } = run([...asked, card, ...heard('pode mandar')])
    expect(states.slice(3)).toEqual(['speaking', 'listening', 'transcribing', 'thinking'])
    expect(effects.slice(3)).toEqual([
      { speak: 'Mandar isto para “Deploy”? Diga Mandar ou Cancelar.' },
      'start-mic',
      'stop-mic',
      { answer: { toolCallId: 'call-1', label: 'Mandar' } },
    ])
    expect(machine.question).toBeNull()
  })

  it('says it did not understand and leaves the card when the answer names no option', () => {
    const { machine, effects } = run([...asked, card, ...heard('talvez amanhã'), { type: 'speech-queue-empty' }])
    expect(effects.at(-1)).toEqual({ speak: 'Não entendi. Toque numa opção.' })
    expect(effects.some((effect) => typeof effect === 'object' && 'answer' in effect)).toBe(false)
    expect(machine.state).toBe('thinking')
  })

  it('reads an approval without listening: the card takes the click', () => {
    const approval = { ...card, speech: 'Aprovar isto em “Deploy”? Confirme no card.', options: [], answerable: false }
    const { machine, effects } = run([...asked, approval, { type: 'speech-queue-empty' }])
    expect(effects.slice(3)).toEqual([{ speak: 'Aprovar isto em “Deploy”? Confirme no card.' }])
    expect(machine.state).toBe('thinking')
  })

  it('stops hearing when the card is answered by a click, and goes back to the turn', () => {
    const { machine, effects } = run([
      ...asked,
      card,
      { type: 'speech-queue-empty' },
      { type: 'question-gone', toolCallId: 'call-1' },
      delta('Mandei para o Deploy. '),
    ])
    expect(effects).toContain('cancel-mic')
    expect(spoken(effects).at(-1)).toBe('Mandei para o Deploy.')
    expect(machine.state).toBe('speaking')
  })

  it('goes back to the turn when it hears nothing, and ignores a card outside a voice session', () => {
    const silent = run([...asked, card, { type: 'speech-queue-empty' }, { type: 'no-speech' }])
    expect(silent.machine).toMatchObject({ state: 'thinking', question: null })
    expect(silent.effects).toContainEqual({ notice: 'no-speech' })
    expect(run([card]).effects).toEqual([])
    expect(run([...asked, card], { autoSpeak: false }).effects.at(-1)).toEqual({ submit: '🎙 como estão as coisas?' })
  })

  it('builds what it says from the card', () => {
    const t = tFor('pt-BR', 'ui')
    const confirm = {
      messageId: 'm',
      toolCallId: 'c',
      questions: [
        {
          header: 'Assistente',
          question: 'Mandar isto para “Deploy”?\n\nRode os testes **agora**.',
          options: [{ label: 'Mandar' }, { label: 'Liberar o resto deste pedido' }, { label: 'Cancelar' }],
        },
      ],
    }
    expect(questionPrompt(confirm, t, 'pt-BR')).toEqual({
      speech: 'Mandar isto para “Deploy”? Diga Mandar, Liberar o resto deste pedido ou Cancelar.',
      options: ['Mandar', 'Liberar o resto deste pedido', 'Cancelar'],
      answerable: true,
    })
    const approval = { ...confirm, questions: [{ ...confirm.questions[0], clickOnly: true }] }
    expect(questionPrompt(approval, t, 'pt-BR')).toMatchObject({
      speech: 'Mandar isto para “Deploy”? Confirme no card.',
      answerable: false,
    })
    const multi = { ...confirm, questions: [confirm.questions[0], confirm.questions[0]] }
    expect(questionPrompt(multi, tFor('en', 'ui'), 'en')).toMatchObject({
      speech: 'Mandar isto para “Deploy”? Answer it in the card.',
      answerable: false,
    })
  })
})
