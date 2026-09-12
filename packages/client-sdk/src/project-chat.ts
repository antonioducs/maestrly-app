import {
  projectChatEventSchema,
  type ChatCreate,
  type ChatDecision,
  type ChatUpdate,
  type ProjectChatEvent,
  type ProjectChatSnapshot,
  type ProjectChatSession,
  type ProjectChatDestination,
} from '@maestrly/protocol'
import type { HttpTransport } from './transport.js'

/** Shared by the server projection and browser; replayed deltas must never be appended twice. */
export function applyProjectChatEvent(state: ProjectChatSnapshot, event: ProjectChatEvent): ProjectChatSnapshot {
  if (event.sessionId !== state.session.id || event.sequence <= state.cursor) return state
  if (event.sequence !== state.cursor + 1) throw new Error('Chat event gap; reload the snapshot.')
  const next = { ...state, cursor: event.sequence },
    p = event.payload
  if (p.type === 'turn') next.turn = p.turn
  else if (p.type === 'interaction')
    next.interactions = [...state.interactions.filter((i) => i.id !== p.interaction.id), p.interaction]
  else if (p.type === 'message')
    next.messages = [...state.messages.filter((m) => m.id !== p.message.id), p.message].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    )
  else {
    next.messages = state.messages.map((m) => {
      if (m.id !== p.messageId) return m
      if (p.type === 'tool') return { ...m, parts: [...m.parts.filter((part) => part.id !== p.part.id), p.part] }
      const old = m.parts.find((part) => part.id === p.partId)
      const part = { id: p.partId, type: p.kind, text: (old && old.type !== 'tool' ? old.text : '') + p.delta }
      return { ...m, parts: old ? m.parts.map((item) => (item.id === part.id ? part : item)) : [...m.parts, part] }
    })
  }
  return next
}

/** Parses complete SSE frames across arbitrary UTF-8/network chunk boundaries. */
export async function* readProjectChatEvents(response: Response): AsyncGenerator<ProjectChatEvent> {
  if (!response.ok || !response.body) throw new Error('Chat stream unavailable: ' + response.status)
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > 4_000_000) throw new Error('Chat stream frame too large.')
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (/^event: access_revoked$/m.test(frame)) throw new Error('Project access was removed.')
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield projectChatEventSchema.parse(JSON.parse(data))
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class ProjectChatClient {
  readonly path: string
  constructor(
    private transport: HttpTransport,
    organizationId: string,
    projectId: string
  ) {
    this.path = `/api/v1/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/chat`
  }
  destinations() {
    return this.transport.request<ProjectChatDestination[]>('GET', this.path + '/destinations')
  }
  sessions(before = '') {
    return this.transport.request<{ items: ProjectChatSession[]; nextCursor: string | null }>(
      'GET',
      this.path + '/sessions?before=' + encodeURIComponent(before)
    )
  }
  create(body: ChatCreate, key: string) {
    return this.transport.request<ProjectChatSession>('POST', this.path + '/sessions', { body, idempotencyKey: key })
  }
  update(id: string, body: ChatUpdate, key: string) {
    return this.transport.request<ProjectChatSession>('PATCH', this.path + '/sessions/' + encodeURIComponent(id), {
      body,
      idempotencyKey: key,
    })
  }
  snapshot(id: string) {
    return this.transport.request<ProjectChatSnapshot>('GET', this.path + '/sessions/' + encodeURIComponent(id))
  }
  send(id: string, text: string, clientMessageId: string) {
    return this.transport.request('POST', this.path + '/sessions/' + encodeURIComponent(id) + '/messages', {
      body: { text, clientMessageId },
      idempotencyKey: clientMessageId,
    })
  }
  cancel(id: string, turnId: string) {
    return this.transport.request(
      'POST',
      this.path + '/sessions/' + encodeURIComponent(id) + '/turns/' + encodeURIComponent(turnId) + '/cancel',
      { body: {}, idempotencyKey: 'cancel-' + turnId }
    )
  }
  decide(id: string, interactionId: string, version: number, decision: ChatDecision, key: string) {
    return this.transport.request(
      'POST',
      this.path +
        '/sessions/' +
        encodeURIComponent(id) +
        '/interactions/' +
        encodeURIComponent(interactionId) +
        '/decisions',
      { body: { version, decision }, idempotencyKey: key }
    )
  }
  events(id: string, cursor: number, signal: AbortSignal) {
    return this.transport.fetch(this.path + '/sessions/' + encodeURIComponent(id) + '/events?cursor=' + cursor, {
      signal,
      headers: { accept: 'text/event-stream' },
    })
  }
}
