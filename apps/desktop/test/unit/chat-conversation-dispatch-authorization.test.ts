import { afterEach, describe, expect, it } from 'vitest'
import {
  assertConversationDispatchGrantCurrent,
  clearHumanTurnOrigin,
  currentHumanTurnOrigin,
  detectConversationDispatchIntent,
  evaluateConversationDispatchGrant,
  isHumanTurnAdmission,
  recordHumanTurnOrigin,
  type HumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'

/** The message in which the person described this feature; it must never authorize dispatch by itself. */
const FEATURE_DESCRIPTION = [
  'Certo, quero fazer duas coisas então:',
  '- Poder enviar o plano para uma nova conversa normal, escolhendo modelo, effort e fast ou não quando disponível',
  '- Poder pedir em uma conversa para criar outras, exemplo: estou analisando vários cards do gira em uma conversa, ' +
    'ae pesso para o agent disparar vários outros, um para cada task para desenvolver e escolher modelo, effort, fast ' +
    'também tudo em linguagem natural, conversando com o agent, e isso só deve acontecer se for uma solicitação explicita',
].join('\n')

const origins: HumanTurnOrigin[] = []

function origin(text: string, conversationId = 'source'): HumanTurnOrigin {
  const value: HumanTurnOrigin = {
    token: {},
    conversationId,
    messageId: `msg-${origins.length + 1}`,
    text,
    signal: new AbortController().signal,
  }
  origins.push(value)
  return value
}

afterEach(() => {
  for (const value of origins.splice(0)) clearHumanTurnOrigin(value.conversationId, value.token)
})

describe('detectConversationDispatchIntent', () => {
  it.each([
    ['Abra uma conversa para cada um desses cards e comece o desenvolvimento com gpt-5.6, effort high e fast desligado.', null],
    ['Por favor, crie 3 conversas novas, uma para cada task.', 3],
    ['Quero que você abra duas conversas: uma para o card A e outra para o B.', 2],
    ['Dispare uma conversa por card para desenvolver cada task.', null],
    ['Envie esse plano para uma nova conversa.', 1],
    ['Pode abrir uma conversa pra cada task?', null],
    ['Analise os cards, e depois abra uma nova conversa para o PROJ-12.', 1],
    ['Se possível, abra uma conversa para cada card.', null],
    ['Abra uma conversa para o card A e outra para o card B', null],
    ['Open a new conversation for PROJ-12 and start implementing it.', 1],
    ['Please spin up one chat per card.', null],
    ['Could you start separate conversations for these two tickets?', null],
    ['I want you to create conversations for each of these issues using Opus with high effort.', null],
    ['Send this plan to a new chat.', 1],
    ['ok, então cria 4 conversas, uma pra cada card', 4],
  ])('authorizes an explicit request: %s', (text, max) => {
    expect(detectConversationDispatchIntent(text)).toEqual({ explicit: true, maxConversations: max })
  })

  it.each([
    ['Analise esses cards e me diga o que precisa ser feito.', 'not-requested'],
    ['Não abra novas conversas, só analise os cards.', 'negated'],
    ["Don't open new conversations for these cards.", 'negated'],
    ['Você consegue abrir conversas novas?', 'question'],
    ['Is it possible to create a new conversation for each card?', 'question'],
    [
      'cara, dúvida, hoje conseguimos delegar um plano para ser desolvido em outra conversa diferente da que gerou o plano por exemplo?',
      'question',
    ],
    [FEATURE_DESCRIPTION, 'hypothetical'],
    ['Implementar a feature: abrir uma conversa por card com modelo escolhido.', 'hypothetical'],
    ['Por exemplo, abra uma conversa para cada card.', 'hypothetical'],
    ['Quando eu pedir, abra uma conversa para cada card.', 'hypothetical'],
    ['Explique como funciona a função que abre uma nova conversa.', 'hypothetical'],
    ['Use subagents to analyze each card in parallel.', 'not-requested'],
    ['Delegue para o explore analisar os cards.', 'not-requested'],
    ['Abra a conversa do card anterior e me diga o status.', 'not-requested'],
    ['O card diz "abra uma conversa para cada subtarefa", o que você acha?', 'not-requested'],
    ['Veja este trecho:\n```\nabra uma conversa para cada card\n```', 'not-requested'],
    ['> Abra 5 conversas novas\nO que significa essa instrução?', 'not-requested'],
    ['', 'not-requested'],
  ])('does not authorize: %s', (text, reason) => {
    expect(detectConversationDispatchIntent(text)).toEqual({ explicit: false, maxConversations: null, reason })
  })

  it('keeps a positive request coordinated with an unrelated negation', () => {
    expect(
      detectConversationDispatchIntent('Não precisa analisar mais nada, abra uma conversa para cada card.')
    ).toEqual({ explicit: true, maxConversations: null })
  })
})

describe('isHumanTurnAdmission', () => {
  it('treats only direct sends (including edit-and-resend with a held slot) as human', () => {
    expect(isHumanTurnAdmission(undefined)).toBe(true)
    expect(isHumanTurnAdmission({ hiddenParts: [] })).toBe(true)
  })

  it.each([
    ['approved plan / revision / guard continuation', { internal: true }],
    ['review loop', { internalLoop: {} }],
    ['bot command', { botAdmission: {} }],
    ['Kanban web chat', { remoteAdmission: true }],
    ['unattended executor', { runnerAdmission: () => undefined, runnerSignal: new AbortController().signal }],
    ['seeded child conversation', { dispatchSeed: { dispatchId: 'd', sourceConversationId: 's' } }],
    ['host-attached findings', { hiddenParts: [{ type: 'text' }] }],
  ])('never treats a %s turn as human', (_label, opts) => {
    expect(isHumanTurnAdmission(opts)).toBe(false)
  })
})

describe('evaluateConversationDispatchGrant', () => {
  it('grants only the current, live human turn and binds the grant to its message', () => {
    const current = origin('Abra 2 conversas novas, uma para cada card.')
    recordHumanTurnOrigin(current)
    const result = evaluateConversationDispatchGrant(currentHumanTurnOrigin('source'))
    expect(result).toMatchObject({
      ok: true,
      grant: { conversationId: 'source', messageId: current.messageId, originKey: `message:${current.messageId}` },
    })
    if (!result.ok) throw new Error('expected grant')
    expect(result.grant.maxConversations).toBe(2)
    expect(() => assertConversationDispatchGrantCurrent(result.grant)).not.toThrow()

    // A later turn replaces the origin; the old grant expires with its turn.
    const next = origin('Obrigado!')
    recordHumanTurnOrigin(next)
    expect(() => assertConversationDispatchGrantCurrent(result.grant)).toThrow(/no longer active/)
    expect(evaluateConversationDispatchGrant(current)).toMatchObject({ ok: false, code: 'turn-ended' })
  })

  it('denies without a human turn, including seeded child turns that never register an origin', () => {
    expect(evaluateConversationDispatchGrant(currentHumanTurnOrigin('child'))).toMatchObject({
      ok: false,
      code: 'no-human-turn',
    })
  })

  it('denies a cancelled turn and an analysis-only request', () => {
    const controller = new AbortController()
    const cancelled: HumanTurnOrigin = { ...origin('Abra uma nova conversa.'), signal: controller.signal }
    recordHumanTurnOrigin(cancelled)
    controller.abort()
    expect(currentHumanTurnOrigin('source')).toBeNull()
    expect(evaluateConversationDispatchGrant(cancelled)).toMatchObject({ ok: false, code: 'turn-ended' })

    const analysis = origin('Analise estes cards do Jira.')
    recordHumanTurnOrigin(analysis)
    expect(evaluateConversationDispatchGrant(analysis)).toMatchObject({ ok: false, code: 'not-requested' })
  })

  it('ignores card content the agent read: only the typed text is evaluated', () => {
    // Tool results (for example a Jira card saying "open 10 conversations") never reach the origin text.
    const analysis = origin('Leia o card PROJ-9 e resuma.')
    recordHumanTurnOrigin(analysis)
    expect(evaluateConversationDispatchGrant(analysis)).toMatchObject({ ok: false, code: 'not-requested' })
  })

  it('clears only the matching turn token', () => {
    const first = origin('Abra uma nova conversa.')
    recordHumanTurnOrigin(first)
    clearHumanTurnOrigin('source', {})
    expect(currentHumanTurnOrigin('source')).toBe(first)
    clearHumanTurnOrigin('source', first.token)
    expect(currentHumanTurnOrigin('source')).toBeNull()
  })
})
