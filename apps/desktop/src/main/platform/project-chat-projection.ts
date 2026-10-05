import { createHash, randomUUID } from 'node:crypto'
import {
  chatInteractionPayloadSchema,
  type ChatPayload,
  type ProjectChatMessage,
  type ProjectChatInteraction,
  type ChatPart,
} from '@maestrly/protocol'
import type { ChatHostEvent } from '../chat/host-events'

export function chatPublicId(value: string) {
  const h = createHash('sha256').update(value).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export function publicChatText(value: unknown, max = 65536): string {
  const redact = (s: string) =>
    s
      .replace(/\bsk-[A-Za-z0-9_-]*/g, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~-]*/gi, 'Bearer [redacted]')
      .replace(/("(?:password|secret|token|apiKey|api_key|authorization|credential)"\s*:\s*")[^"]*/gi, '$1[redacted]')
  const raw =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value, (key, v) =>
          /^(?:password|secret|token|apiKey|api_key|authorization|credential)$/i.test(key)
            ? '[redacted]'
            : typeof v === 'string'
              ? redact(v)
              : v
        ) ?? '')
  const safe = redact(raw)
  return safe.length > max ? safe.slice(0, max) + '\n[truncated]' : safe
}
export class ProjectChatProjection {
  private rawText = new Map<string, string>()
  readonly messages = new Map<string, ProjectChatMessage>()
  readonly interactions = new Map<string, ProjectChatInteraction>()
  constructor(
    private sessionId: string,
    private turnId: string,
    private emit: (p: ChatPayload) => void
  ) {}
  receive(event: ChatHostEvent) {
    const e = event.payload as Record<string, any>
    if (!e || typeof e !== 'object') return
    if (event.channel === 'plan:received') {
      this.interaction(
        {
          type: 'plan',
          requestId: String(e.version),
          title: publicChatText(e.title ?? 'Plan', 500),
          plan: publicChatText(e.plan, 199900),
        },
        e.version
      )
      return
    }
    if (event.channel === 'question') {
      this.interaction({
        type: 'question',
        requestId: e.toolCallId,
        questions: e.questions.map((q: any) => ({
          header: q.header,
          question: q.question,
          options: q.options ?? [],
          multiple: q.multiSelect,
        })),
      })
      return
    }
    if (event.channel.startsWith('chat:permission:')) {
      if (e.kind === 'request')
        this.interaction({
          type: 'permission',
          requestId: e.request.id,
          title: publicChatText(e.request.title ?? e.request.toolName, 8000),
          action: e.request.action,
          resources: e.request.resources.map((r: string) => publicChatText(r, 8000)),
        })
      return
    }
    const publicSummary=event.channel==='chat:public-summary'
    if (!event.channel.startsWith('chat:delta:')&&!publicSummary) return
    const nativeId = e.messageId
    if (!nativeId) return
    const id = chatPublicId(this.sessionId + ':' + this.turnId + ':' + nativeId)
    if (e.kind === 'message-start') {
      if (this.messages.has(id)) return
      const message: ProjectChatMessage = {
        id,
        sessionId: this.sessionId,
        turnId: this.turnId,
        role: 'assistant',
        createdAt: new Date(e.createdAt ?? Date.now()).toISOString(),
        parts: [],
      }
      this.messages.set(id, message)
      this.emit({ type: 'message', message: structuredClone(message) })
      return
    }
    const message = this.messages.get(id)
    if (!message) return
    if (e.kind === 'text-delta'||publicSummary) {
      const kind=publicSummary?'reasoning':'text'
      const part = message.parts.find((p) => p.id === e.partId)
      if (part?.type === 'tool') return
      const key = id + ':' + e.partId,
        raw = (this.rawText.get(key) ?? '') + e.delta
      if (raw.length > 990000) throw new Error('Chat response size limit reached.')
      this.rawText.set(key, raw)
      const text = publicChatText(raw, 999000),
        previous = part?.text ?? ''
      if (part) part.text = text
      else message.parts.push({ type: kind, id: e.partId, text })
      // A credential prefix can span chunks. Reconcile the whole part when redaction changes a prior prefix.
      if (!text.startsWith(previous)) {
        this.emit({ type: 'message', message: structuredClone(message) })
        return
      }
      const delta = text.slice(previous.length)
      for (let start = 0; start < delta.length; start += 32000)
        this.emit({
          type: 'delta',
          messageId: id,
          partId: e.partId,
          kind,
          delta: delta.slice(start, start + 32000),
        })
    } else if (['tool-input-start', 'tool-call', 'tool-state'].includes(e.kind)) {
      const old = message.parts.find((p) => p.id === e.toolCallId)
      const part: ChatPart = {
        ...(old?.type === 'tool' ? old : {}),
        type: 'tool',
        id: e.toolCallId,
        name: e.toolName ?? (old?.type === 'tool' ? old.name : 'tool'),
        state: e.state?.status ?? (e.kind === 'tool-call' ? 'running' : 'pending'),
        ...(e.input !== undefined ? { input: publicChatText(e.input, 32000) } : {}),
        ...(e.state?.output !== undefined || e.state?.error
          ? { output: publicChatText(e.state.error ?? e.state.output, 65000) }
          : {}),
      }
      if (old) message.parts = message.parts.map((p) => (p.id === part.id ? part : p))
      else message.parts.push(part)
      this.emit({ type: 'tool', messageId: id, part })
    }
    // Raw provider reasoning deltas and internal compaction/control text are deliberately not projected.
  }
  private interaction(payload: unknown, version = 1) {
    const parsed = chatInteractionPayloadSchema.parse(payload),
      key = parsed.type + ':' + parsed.requestId
    if (this.interactions.has(key)) return
    const interaction: ProjectChatInteraction = {
      id: randomUUID(),
      sessionId: this.sessionId,
      turnId: this.turnId,
      version,
      payload: parsed,
      state: 'pending',
      decision: null,
    }
    this.interactions.set(key, interaction)
    this.emit({ type: 'interaction', interaction })
  }
  finish() {
    for (const message of this.messages.values()) this.emit({ type: 'message', message: structuredClone(message) })
  }
}
