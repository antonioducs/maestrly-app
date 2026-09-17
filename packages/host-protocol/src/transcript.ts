import { TURN_TERMINAL, type BotEvent, type BotMessage, type BotTurn } from './bots.js'
import { TOOL_OUTPUT_MAX, type TranscriptMessage, type TranscriptPart } from './chat.js'

/**
 * The single projection from durable rows to what a person reads. The Host runs it over a page
 * of history; the application runs `applyTranscriptEvent` over each live event with the same
 * rules, so nothing can be shown live that the history would later contradict.
 *
 * Shape: every user or system message is its own entry; every turn becomes one assistant entry
 * (`turn:<turnId>`) whose parts follow the order of events — text, reasoning, tools, files.
 */
export interface TranscriptLookup {
  /** The persisted assistant message an `assistant.message` event produced, by its runtime event id. */
  messageByRuntimeEventId?: (runtimeEventId: string) => BotMessage | undefined
  /** The n-th persisted assistant message of a turn, for events that carry no runtime id. */
  messageOfTurn?: (turnId: string, index: number) => BotMessage | undefined
}

const turnCardId = (turnId: string) => `turn:${turnId}`
const ROLE_ORDER: Record<TranscriptMessage['role'], number> = { user: 0, system: 0, assistant: 1 }

function sortTranscript(messages: TranscriptMessage[]): TranscriptMessage[] {
  return [...messages].sort(
    (a, b) => a.sequence - b.sequence || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.createdAt.localeCompare(b.createdAt)
  )
}

function durationBetween(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
  if (!startedAt || !finishedAt) return undefined
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : undefined
}

function fromTurn(turn: BotTurn, sequence: number, createdAt: string): TranscriptMessage {
  return {
    id: turnCardId(turn.id),
    conversationId: turn.conversationId,
    role: 'assistant',
    turnId: turn.id,
    sequence,
    createdAt,
    parts: [],
    attachments: [],
    turnStatus: turn.status,
    ...(turn.startedAt ? { responseStartedAt: turn.startedAt } : {}),
    ...(durationBetween(turn.startedAt, turn.finishedAt) != null ? { responseDurationMs: durationBetween(turn.startedAt, turn.finishedAt) } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    streaming: !TURN_TERMINAL.has(turn.status),
  }
}

function fromMessage(message: BotMessage): TranscriptMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    sequence: message.sequence,
    createdAt: message.createdAt,
    parts: message.content ? [{ type: 'text', id: `${message.id}:text`, text: message.content }] : [],
    attachments: message.attachments,
    streaming: false,
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const clipOutput = (value: string) => (value.length > TOOL_OUTPUT_MAX ? value.slice(value.length - TOOL_OUTPUT_MAX) : value)

/** A text part an `assistant.message` sealed; later deltas start a new paragraph after it. */
const FINAL = ':final'
/** Appends to the last open part of the given kind, or opens a new one after whatever came last. */
function appendText(parts: TranscriptPart[], kind: 'text' | 'reasoning', id: string, delta: string): TranscriptPart[] {
  const last = parts[parts.length - 1]
  if (last && last.type === kind && !last.id.endsWith(FINAL)) return [...parts.slice(0, -1), { ...last, text: last.text + delta }]
  return [...parts, { type: kind, id, text: delta }]
}

/**
 * Applies one event to the transcript, returning a new array. `turn` supplies durable fields
 * (status, usage, error, timing) when the caller has them; without it the event alone decides.
 */
export function applyTranscriptEvent(
  current: TranscriptMessage[],
  event: BotEvent,
  turn?: BotTurn,
  lookup: TranscriptLookup = {}
): TranscriptMessage[] {
  const turnId = event.turnId ?? turn?.id
  if (!turnId) return current
  const detail = event.detail ?? {}
  let index = current.findIndex((message) => message.id === turnCardId(turnId))
  let next = current
  if (index < 0) {
    // The card starts beside the person's message that opened the turn.
    const opener = current.find((message) => message.role !== 'assistant' && message.turnId === turnId)
    const sequence = opener?.sequence ?? Math.max(0, ...current.map((message) => message.sequence))
    const created = event.createdAt
    const card = turn
      ? fromTurn(turn, sequence, created)
      : {
          id: turnCardId(turnId),
          conversationId: event.conversationId ?? opener?.conversationId ?? '',
          role: 'assistant' as const,
          turnId,
          sequence,
          createdAt: created,
          parts: [],
          attachments: [],
          streaming: true,
        }
    next = sortTranscript([...current, card])
    index = next.findIndex((message) => message.id === card.id)
  }
  const card = next[index]
  let updated: TranscriptMessage = card
  switch (event.kind) {
    case 'assistant.delta': {
      const piece = text(detail.text)
      if (!piece) break
      const kind = detail.channel === 'reasoning' ? 'reasoning' : 'text'
      updated = { ...card, parts: appendText(card.parts, kind, `${card.id}:${event.seq}`, piece) }
      break
    }
    case 'assistant.message': {
      // The persisted message carries the full text; the event only has a preview. Without a
      // runtime id the n-th message event of the turn pairs with its n-th persisted message.
      const sealedBefore = card.parts.filter((part) => part.type === 'text' && part.id.endsWith(FINAL)).length
      const persisted =
        (event.runtimeEventId ? lookup.messageByRuntimeEventId?.(event.runtimeEventId) : undefined) ?? lookup.messageOfTurn?.(turnId, sealedBefore)
      // Already shown from the persisted row (a fold without events): nothing to add twice.
      if (persisted && card.parts.some((part) => part.id === `${persisted.id}:text`)) return next
      const content = persisted?.content ?? (text(detail.content) || text(detail.preview))
      const last = card.parts[card.parts.length - 1]
      // Sealing the paragraph (the id says so) makes the next delta open a new one.
      const sealed = { type: 'text' as const, id: `${card.id}:${event.seq}${FINAL}` }
      // Attachments the Host stored on that message belong to the card as well.
      const attachments = persisted?.attachments.filter((file) => !card.attachments.some((known) => known.path === file.path)) ?? []
      updated = {
        ...card,
        ...(attachments.length ? { attachments: [...card.attachments, ...attachments] } : {}),
        parts:
          last && last.type === 'text' && !last.id.endsWith(FINAL)
            ? [...card.parts.slice(0, -1), { ...sealed, text: content || last.text }]
            : content
              ? [...card.parts, { ...sealed, text: content }]
              : card.parts,
      }
      break
    }
    case 'tool.started': {
      const callId = text(detail.callId) || `seq:${event.seq}`
      const toolName = text(detail.name) || text(detail.tool) || 'tool'
      const input = detail.arguments ?? detail.command
      updated = {
        ...card,
        parts: [
          ...card.parts,
          {
            type: 'tool',
            id: `tool:${callId}`,
            callId,
            toolName: toolName.slice(0, 80),
            summary: (event.summary || toolName).slice(0, 400),
            ...(input !== undefined ? { input } : {}),
            state: 'running',
            startedAt: event.createdAt,
          },
        ],
      }
      break
    }
    case 'tool.finished': {
      const callId = text(detail.callId)
      const toolKind = text(detail.tool)
      let i = card.parts.findIndex((part) => part.type === 'tool' && part.callId === callId && callId)
      // An older guest sends no call id: close the oldest still-running tool of the same kind.
      if (i < 0)
        i = card.parts.findIndex(
          (part) => part.type === 'tool' && part.state === 'running' && (!toolKind || part.toolName === toolKind || part.summary === event.summary)
        )
      const exitCode = typeof detail.exitCode === 'number' && Number.isInteger(detail.exitCode) ? detail.exitCode : undefined
      const failed = (exitCode != null && exitCode !== 0) || detail.error != null || detail.isError === true
      const changes = Array.isArray(detail.changes)
        ? (detail.changes as unknown[])
            .filter((c): c is { path: string; kind?: string } => !!c && typeof c === 'object' && typeof (c as { path?: unknown }).path === 'string')
            .slice(0, 64)
            .map((c) => ({ path: c.path.slice(0, 512), kind: (c.kind ?? 'change').slice(0, 20) }))
        : undefined
      const output = text(detail.output)
      const finished = {
        state: failed ? ('error' as const) : ('done' as const),
        finishedAt: event.createdAt,
        ...(output ? { output: clipOutput(output) } : {}),
        ...(exitCode != null ? { exitCode } : {}),
        ...(changes?.length ? { changes } : {}),
      }
      if (i >= 0) {
        const part = card.parts[i] as Extract<TranscriptPart, { type: 'tool' }>
        updated = { ...card, parts: card.parts.map((p, j) => (j === i ? { ...part, ...finished } : p)) }
      } else {
        const id = callId || `seq:${event.seq}`
        updated = {
          ...card,
          parts: [
            ...card.parts,
            {
              type: 'tool',
              id: `tool:${id}`,
              callId: id,
              toolName: (text(detail.name) || toolKind || 'tool').slice(0, 80),
              summary: (event.summary || toolKind || 'tool').slice(0, 400),
              startedAt: event.createdAt,
              ...finished,
            },
          ],
        }
      }
      break
    }
    case 'file.produced': {
      if (typeof detail.path !== 'string' || typeof detail.name !== 'string' || typeof detail.size !== 'number') break
      updated = {
        ...card,
        parts: [...card.parts, { type: 'file', id: `file:${event.seq}`, path: detail.path.slice(0, 512), name: detail.name.slice(0, 255), size: Math.max(0, Math.round(detail.size)) }],
      }
      break
    }
    case 'turn.status': {
      const status = text(detail.status) as BotTurn['status'] | ''
      const terminal = !!status && TURN_TERMINAL.has(status as BotTurn['status'])
      const startedAt = card.responseStartedAt ?? (status === 'running' ? event.createdAt : undefined)
      const finishedAt = terminal ? (turn?.finishedAt ?? event.createdAt) : undefined
      const error = detail.error && typeof detail.error === 'object' ? (detail.error as { code: string; message: string }) : turn?.error
      updated = {
        ...card,
        ...(status ? { turnStatus: status as BotTurn['status'] } : {}),
        ...(startedAt ? { responseStartedAt: turn?.startedAt ?? startedAt } : {}),
        ...(terminal && durationBetween(turn?.startedAt ?? startedAt, finishedAt) != null ? { responseDurationMs: durationBetween(turn?.startedAt ?? startedAt, finishedAt) } : {}),
        ...(turn?.usage ? { usage: turn.usage } : {}),
        ...(terminal && error ? { error: { code: String(error.code), message: String(error.message) } } : {}),
        streaming: terminal ? false : card.streaming,
      }
      break
    }
    default:
      return next
  }
  return next.map((message, i) => (i === index ? updated : message))
}

export function foldTranscript(input: { messages: BotMessage[]; turns: BotTurn[]; events: BotEvent[] }): TranscriptMessage[] {
  const turns = new Map(input.turns.map((turn) => [turn.id, turn]))
  const assistant = input.messages.filter((m) => m.role === 'assistant').sort((a, b) => a.sequence - b.sequence)
  const byRuntimeEventId = new Map(assistant.map((m) => [m.clientMessageId, m]))
  const lookup: TranscriptLookup = {
    messageByRuntimeEventId: (id) => byRuntimeEventId.get(id),
    messageOfTurn: (turnId, index) => assistant.filter((m) => m.turnId === turnId)[index],
  }
  // Every persisted non-assistant message stands on its own; assistant rows are absorbed into turn cards.
  let transcript: TranscriptMessage[] = input.messages.filter((m) => m.role !== 'assistant').map(fromMessage)
  for (const turn of input.turns) {
    const opener = input.messages.find((m) => m.id === turn.messageId) ?? input.messages.find((m) => m.turnId === turn.id && m.role !== 'assistant')
    const firstAssistant = input.messages.find((m) => m.turnId === turn.id && m.role === 'assistant')
    const sequence = opener?.sequence ?? firstAssistant?.sequence ?? 0
    transcript.push(fromTurn(turn, sequence, firstAssistant?.createdAt ?? turn.startedAt ?? turn.createdAt))
  }
  transcript = sortTranscript(transcript)
  const events = [...input.events].sort((a, b) => a.seq - b.seq)
  for (const event of events) transcript = applyTranscriptEvent(transcript, event, event.turnId ? turns.get(event.turnId) : undefined, lookup)
  // A turn whose events are gone (or never had any) still shows what the Host persisted for it.
  const covered = new Set(events.map((event) => event.turnId).filter(Boolean))
  transcript = transcript.map((message) => {
    if (message.role !== 'assistant' || !message.turnId || covered.has(message.turnId) || message.parts.length) return message
    const persisted = input.messages.filter((m) => m.turnId === message.turnId && m.role === 'assistant')
    return {
      ...message,
      parts: persisted.map((m) => ({ type: 'text' as const, id: `${m.id}:text`, text: m.content })),
      attachments: persisted.flatMap((m) => m.attachments),
    }
  })
  return transcript
}

/** Largest event sequence folded, for a live subscription to continue from. */
export function transcriptCursor(events: readonly BotEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}
