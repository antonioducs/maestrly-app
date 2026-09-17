import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CHAT_HOST_CAPABILITY,
  EXTENSIONS_CAPABILITY,
  TOOL_OUTPUT_MAX,
  TRANSCRIPT_CAPABILITY,
  applyTranscriptEvent,
  botResultSchemas,
  botTurnSchema,
  foldTranscript,
  requestSchema,
  transcriptCursor,
  transcriptMessageSchema,
  transcriptPageSchema,
  transcriptPartSchema,
  usageSchema,
  type BotEvent,
  type BotMessage,
  type BotTurn,
} from '../src/index.js'

/** Rows recorded on the Mac mini laboratory Host: one scheduled turn, one turn that used tools. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/transcript-events.json', import.meta.url), 'utf8')) as {
  routine: { turn: BotTurn; events: BotEvent[]; messages: BotMessage[] }
  tools: { turn: BotTurn; events: BotEvent[]; messages: BotMessage[] }
}

describe('chat capabilities and schemas', () => {
  it('names the three capabilities and the transcript method on the shared envelope', () => {
    expect(CHAT_HOST_CAPABILITY).toBe('chat.experience.v1')
    expect(TRANSCRIPT_CAPABILITY).toBe('bot.transcript.v1')
    expect(EXTENSIONS_CAPABILITY).toBe('bot.extensions.v1')
    expect(requestSchema.safeParse({ version: 1, id: 'r', method: 'bot.transcript.list', params: { botId: 'b' } }).success).toBe(true)
    expect(botResultSchemas['bot.transcript.list']).toBe(transcriptPageSchema)
  })
  it('accepts the richer usage fields and refuses negatives, and turns may name their model', () => {
    expect(usageSchema.safeParse({ inputTokens: 1, cachedInputTokens: 3, reasoningOutputTokens: 2, contextTokens: 90, modelContextWindow: 272000 }).success).toBe(true)
    expect(usageSchema.safeParse({ cachedInputTokens: -1 }).success).toBe(false)
    expect(botTurnSchema.safeParse({ ...fixture.tools.turn, model: { model: 'gpt-5', source: 'recommended' } }).success).toBe(true)
  })
  it('bounds a tool output at TOOL_OUTPUT_MAX', () => {
    const part = { type: 'tool', id: 't', callId: 'c', toolName: 'bash', summary: 's', state: 'done', startedAt: '2026-09-17T00:00:00.000Z' }
    expect(transcriptPartSchema.safeParse({ ...part, output: 'x'.repeat(TOOL_OUTPUT_MAX) }).success).toBe(true)
    expect(transcriptPartSchema.safeParse({ ...part, output: 'x'.repeat(TOOL_OUTPUT_MAX + 1) }).success).toBe(false)
  })
})

describe('foldTranscript over rows recorded on real hardware', () => {
  it('folds a scheduled turn into one finished assistant card with its real duration', () => {
    const { turn, events, messages } = fixture.routine
    const transcript = foldTranscript({ messages, turns: [turn], events })
    for (const message of transcript) expect(transcriptMessageSchema.safeParse(message).success, message.id).toBe(true)
    const cards = transcript.filter((message) => message.role === 'assistant')
    expect(cards).toHaveLength(1)
    const [card] = cards
    expect(card.id).toBe(`turn:${turn.id}`)
    expect(card.streaming).toBe(false)
    expect(card.turnStatus).toBe('succeeded')
    expect(card.responseDurationMs).toBe(Date.parse(turn.finishedAt!) - Date.parse(turn.startedAt!))
    // This turn ran in a routine thread, whose rows are not on the bot's own page: the card still
    // carries the text the events delivered.
    const text = card.parts.find((part) => part.type === 'text')
    const delivered = events.find((event) => event.kind === 'assistant.message')!.detail!.preview
    expect(text && text.type === 'text' && text.text).toBe(delivered)
  })
  it('turns tool events into tool parts, in order, closed with their exit code', () => {
    const { turn, events, messages } = fixture.tools
    const transcript = foldTranscript({ messages, turns: [turn], events })
    const card = transcript.find((message) => message.id === `turn:${turn.id}`)!
    const tools = card.parts.filter((part) => part.type === 'tool')
    expect(tools.length).toBe(events.filter((event) => event.kind === 'tool.started').length)
    expect(tools.every((part) => part.type === 'tool' && part.state !== 'running')).toBe(true)
    // The person's message comes first, the card right after it.
    const user = transcript.find((message) => message.role === 'user')!
    expect(transcript.indexOf(user)).toBeLessThan(transcript.indexOf(card))
    // Several assistant messages in one turn become several text parts, never separate cards.
    expect(card.parts.filter((part) => part.type === 'text').length).toBe(messages.filter((m) => m.role === 'assistant').length)
    expect(transcriptCursor(events)).toBe(Math.max(...events.map((event) => event.seq)))
  })
  it('keeps a tool running and the card streaming until the finishing events arrive', () => {
    const { turn, events, messages } = fixture.tools
    const firstStart = events.findIndex((event) => event.kind === 'tool.started')
    const partial = events.slice(0, firstStart + 1)
    const running = { ...turn, status: 'running' as const, finishedAt: undefined }
    const card = foldTranscript({ messages: messages.filter((m) => m.role === 'user'), turns: [running], events: partial }).find(
      (message) => message.id === `turn:${turn.id}`
    )!
    expect(card.streaming).toBe(true)
    const tool = card.parts.at(-1)!
    expect(tool.type === 'tool' && tool.state).toBe('running')
  })
  it('produces the same transcript whether events are folded at once or applied one by one', () => {
    const { turn, events, messages } = fixture.tools
    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    const atOnce = foldTranscript({ messages, turns: [turn], events: sorted })
    // Live path: a page folded up to the middle of the turn, then every later event applied as it arrives.
    const split = sorted.findIndex((event) => event.kind === 'tool.started') + 1
    let live = foldTranscript({ messages, turns: [turn], events: sorted.slice(0, split) })
    const byRuntimeEventId = new Map(messages.filter((m) => m.role === 'assistant').map((m) => [m.clientMessageId, m]))
    for (const event of sorted.slice(split)) live = applyTranscriptEvent(live, event, turn, { messageByRuntimeEventId: (id) => byRuntimeEventId.get(id) })
    expect(live).toEqual(atOnce)
    // And the persisted message wins over the 400-character preview the event carries.
    const card = atOnce.find((message) => message.id === `turn:${turn.id}`)!
    const texts = card.parts.filter((part) => part.type === 'text').map((part) => part.type === 'text' && part.text)
    expect(texts).toEqual(messages.filter((m) => m.role === 'assistant').map((m) => m.content))
  })
  it('treats reasoning deltas as their own part and a call id as the tool identity', () => {
    const base = fixture.routine
    const turn: BotTurn = { ...base.turn, status: 'running', finishedAt: undefined }
    const at = '2026-09-17T21:00:00.000Z'
    const mk = (seq: number, kind: BotEvent['kind'], detail: Record<string, unknown>, summary = kind): BotEvent => ({
      seq,
      botId: turn.botId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      kind,
      summary,
      detail,
      createdAt: at,
    })
    const events = [
      mk(1, 'assistant.delta', { text: 'hmm', channel: 'reasoning' }),
      mk(2, 'tool.started', { callId: 'c1', tool: 'commandExecution', command: 'ls' }, 'Executando um comando'),
      mk(3, 'tool.finished', { callId: 'c1', tool: 'commandExecution', output: 'a\nb', exitCode: 2 }, 'Executando um comando'),
      mk(4, 'assistant.delta', { text: 'done' }),
    ]
    const card = foldTranscript({ messages: base.messages.filter((m) => m.role === 'user'), turns: [turn], events }).find((m) => m.role === 'assistant')!
    expect(card.parts.map((part) => part.type)).toEqual(['reasoning', 'tool', 'text'])
    const tool = card.parts[1]
    expect(tool.type === 'tool' && tool.callId).toBe('c1')
    expect(tool.type === 'tool' && tool.state).toBe('error')
    expect(tool.type === 'tool' && tool.output).toBe('a\nb')
    expect(tool.type === 'tool' && tool.input).toBe('ls')
  })
})
