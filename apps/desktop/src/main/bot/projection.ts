import type { ChatHostEvent } from '../chat/host-events'

export interface BotPublicQuestion {
  header: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiple: boolean
}

export interface BotPublicInteraction {
  requestId: string
  type: 'question' | 'permission' | 'plan'
  ownerOnly: boolean
  title?: string
  questions?: BotPublicQuestion[]
}

/** Only explicitly public message text crosses the relay. Tool payloads never enter this projection. */
export function botPublicText(value: unknown, limit = 64_000): string {
  if (typeof value !== 'string') return ''
  const safe = value
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/("(?:password|secret|token|apiKey|api_key|authorization|credential)"\s*:\s*")[^"]*/gi, '$1[redacted]')
  return safe.length > limit ? safe.slice(0, limit) + '\n[truncated]' : safe
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export class BotConversationProjection {
  private readonly messages = new Map<string, Map<string, string>>()
  private readonly interactions = new Set<string>()
  private finished = false

  constructor(private readonly emit: (event: Record<string, unknown>) => void) {}

  receive(event: ChatHostEvent): void {
    if (this.finished) return
    const payload = record(event.payload)
    if (!payload) return
    if (event.channel === 'question' && typeof payload.toolCallId === 'string' && Array.isArray(payload.questions)) {
      const questions = payload.questions.flatMap((value) => {
        const question = record(value)
        if (!question || typeof question.question !== 'string') return []
        return [
          {
            header: botPublicText(question.header, 160),
            question: botPublicText(question.question, 8_000),
            options: (Array.isArray(question.options) ? question.options : []).flatMap((value) => {
              const option = record(value)
              return option && typeof option.label === 'string'
                ? [
                    {
                      label: botPublicText(option.label, 500),
                      ...(typeof option.description === 'string'
                        ? { description: botPublicText(option.description, 2_000) }
                        : {}),
                    },
                  ]
                : []
            }),
            multiple: question.multiSelect === true,
          },
        ]
      })
      this.interaction({ requestId: payload.toolCallId, type: 'question', ownerOnly: false, questions })
      return
    }
    if (
      event.channel === 'plan:received' &&
      (typeof payload.version === 'number' || typeof payload.version === 'string')
    ) {
      this.interaction({
        requestId: String(payload.version),
        type: 'plan',
        ownerOnly: true,
        title: botPublicText(payload.title, 500),
      })
      return
    }
    if (event.channel.startsWith('chat:permission:') && payload.kind === 'request') {
      const request = record(payload.request)
      if (request && typeof request.id === 'string') {
        this.interaction({
          requestId: request.id,
          type: 'permission',
          ownerOnly: true,
          title: botPublicText(request.title, 500),
        })
      }
      return
    }
    if (event.channel.startsWith('chat:permission:') && payload.kind === 'resolved') {
      this.emit({ type: 'owner-attention', attention: null })
      return
    }
    if (!event.channel.startsWith('chat:delta:') || typeof payload.messageId !== 'string') return
    if (payload.kind === 'message-start') {
      if (
        payload.internal ||
        payload.reviewLoop ||
        (record(payload.executionScope)?.kind ?? 'conversation') !== 'conversation'
      )
        return
      if (!this.messages.has(payload.messageId)) this.messages.set(payload.messageId, new Map())
    } else if (
      payload.kind === 'text-delta' &&
      typeof payload.delta === 'string' &&
      typeof payload.partId === 'string'
    ) {
      const parts = this.messages.get(payload.messageId)
      if (!parts) return
      const next = (parts.get(payload.partId) ?? '') + payload.delta
      if (next.length > 1_000_000)
        throw new Error('Bot response size limit reached; the native transcript is preserved.')
      parts.set(payload.partId, next)
    }
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    for (const [messageId, parts] of this.messages) {
      const text = botPublicText([...parts.values()].join('\n\n'))
      if (text) this.emit({ type: 'message', messageId, role: 'assistant', text })
    }
  }

  private interaction(interaction: BotPublicInteraction): void {
    const key = `${interaction.type}:${interaction.requestId}`
    if (this.interactions.has(key)) return
    this.interactions.add(key)
    this.emit({ type: 'interaction', interaction })
  }
}
