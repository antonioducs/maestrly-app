import type {
  FleetChatAttentionKind,
  FleetGatewayEvent,
  FleetPushCategory,
  FleetPushData,
  FleetPushRegistration,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'

/** One notification for one phone. */
export type PushMessage = { to: string; title: string; body: string; data: FleetPushData }
/** What became of a message: a token the push service no longer knows is dropped. */
export type PushOutcome = { ok: true } | { ok: false; unregistered: boolean }

/** Who delivers notifications: Expo's push service now; a relay of the owner's own could replace it. */
export interface PushSender {
  send(messages: PushMessage[]): Promise<PushOutcome[]>
}

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_BATCH = 100

type ExpoTicket = { status: 'ok'; id?: string } | { status: 'error'; message?: string; details?: { error?: string } }

/** Sends through Expo's push service, which passes notifications on to Apple's and Google's. */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly options: { accessToken: string | null; url?: string; fetch?: typeof fetch; timeoutMs?: number }
  ) {}

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const outcomes: PushOutcome[] = []
    for (let start = 0; start < messages.length; start += EXPO_BATCH)
      outcomes.push(...(await this.batch(messages.slice(start, start + EXPO_BATCH))))
    return outcomes
  }

  private async batch(messages: PushMessage[]): Promise<PushOutcome[]> {
    const failed = (): PushOutcome[] => messages.map(() => ({ ok: false, unregistered: false }))
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(this.options.url ?? EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.options.accessToken ? { authorization: 'Bearer ' + this.options.accessToken } : {}),
        },
        body: JSON.stringify(
          messages.map((message) => ({
            to: message.to,
            title: message.title,
            body: message.body,
            data: message.data,
            sound: 'default',
            priority: 'high',
            channelId: 'default',
          }))
        ),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      })
    } catch {
      return failed()
    }
    if (!response.ok) return failed()
    let tickets: ExpoTicket[]
    try {
      const body = (await response.json()) as { data?: unknown }
      tickets = Array.isArray(body.data) ? (body.data as ExpoTicket[]) : []
    } catch {
      return failed()
    }
    return messages.map((_, index) => {
      const ticket = tickets[index]
      if (ticket?.status === 'ok') return { ok: true }
      return { ok: false, unregistered: ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' }
    })
  }
}

type Phrase =
  | 'permission'
  | 'question'
  | 'help'
  | 'plan'
  | 'finished'
  | 'routine'
  | 'turnFailed'
  | 'botFailed'
  | 'chatFailed'
  | 'test'

/** The fixed phrases a notification says, in the phone's language: never anything the bot or chat wrote. */
const PHRASES: Record<'en' | 'pt-BR', Record<Phrase, string>> = {
  en: {
    permission: 'Needs your approval',
    question: 'Has a question for you',
    help: 'Needs your help',
    plan: 'Has a plan for you',
    finished: 'Finished its turn',
    routine: 'Routine report ready',
    turnFailed: 'A turn failed',
    botFailed: 'Stopped unexpectedly',
    chatFailed: 'Stopped with an error',
    test: 'Notifications from {server} work.',
  },
  'pt-BR': {
    permission: 'Precisa da sua aprovação',
    question: 'Tem uma pergunta para você',
    help: 'Precisa da sua ajuda',
    plan: 'Tem um plano para você',
    finished: 'Terminou o turno',
    routine: 'Relatório da rotina pronto',
    turnFailed: 'Um turno falhou',
    botFailed: 'Parou inesperadamente',
    chatFailed: 'Parou com um erro',
    test: 'As notificações de {server} funcionam.',
  },
}
const phrase = (locale: string, key: Phrase, server: string) =>
  (/^pt\b/i.test(locale) ? PHRASES['pt-BR'] : PHRASES.en)[key].replace('{server}', server)

const CHAT_PHRASES: Record<FleetChatAttentionKind, { category: FleetPushCategory; phrase: Phrase }> = {
  waiting: { category: 'waiting', phrase: 'permission' },
  question: { category: 'waiting', phrase: 'question' },
  plan: { category: 'waiting', phrase: 'plan' },
  finished: { category: 'replies', phrase: 'finished' },
  failed: { category: 'errors', phrase: 'chatFailed' },
}

export interface PushStore {
  activePushRegistrations(): { deviceId: string; registration: FleetPushRegistration }[]
  pushRegistration(deviceId: string): FleetPushRegistration | null
  deletePushRegistration(deviceId: string): boolean
  getBot(id: string): { name: string } | null
}

/**
 * Turns what happens on the server into notifications for the phones that asked for them: a request that waits on
 * the owner, a finished turn or routine, and a failure, of bots and of the workspaces host's chats. A notification
 * goes once per phone and conversation within a short window, so a burst of updates sends one.
 */
export class PushNotifier {
  private pending: Set<string> | null = null
  private readonly recent = new Map<string, number>()
  private readonly now: () => number

  constructor(
    private readonly deps: {
      store: PushStore
      sender: PushSender
      /** How the server names itself in a test notification. */
      serverName: () => string
      now?: () => number
      log?: (message: string) => void
      /** How long the same notification is not sent again. */
      windowMs?: number
    }
  ) {
    this.now = deps.now ?? Date.now
  }

  /** Sees every gateway event, whether or not a device is streaming them. */
  observe(event: FleetGatewayEvent): void {
    if (event.type === 'inbox.updated') {
      const keys = new Set(
        event.items.map(({ botId, interaction }) => `${botId}\0${interaction.kind}\0${interaction.id}`)
      )
      const before = this.pending ?? new Set<string>()
      this.pending = keys
      for (const { botId, interaction } of event.items) {
        if (before.has(`${botId}\0${interaction.kind}\0${interaction.id}`)) continue
        void this.bot(botId, 'waiting', interaction.kind, interaction.id)
      }
      return
    }
    if (event.type !== 'activity' || !event.entry.botId) return
    const { botId, kind, data } = event.entry
    if (kind === 'turn_completed') {
      if (data.source === 'routine') void this.bot(botId, 'routines', 'routine', String(event.entry.seq))
      else if (data.source === 'owner') void this.bot(botId, 'replies', 'finished', String(event.entry.seq))
    } else if (kind === 'turn_failed') void this.bot(botId, 'errors', 'turnFailed', String(event.entry.seq))
    else if (kind === 'bot_failed') void this.bot(botId, 'errors', 'botFailed', String(event.entry.seq))
  }

  /** A chat of the workspaces host needs the owner. */
  chat(conversationId: string, name: string, kind: FleetChatAttentionKind): Promise<void> {
    const { category, phrase: key } = CHAT_PHRASES[kind]
    return this.send({ kind: 'chat', id: conversationId, name }, category, key, `${kind}:${conversationId}`)
  }

  /** Sends one phone a test notification; throws when it has not registered. */
  async test(deviceId: string): Promise<void> {
    const registration = this.deps.store.pushRegistration(deviceId)
    if (!registration) throw new GatewayError('NOT_FOUND', 'This phone has not registered for notifications')
    const [outcome] = await this.deps.sender.send([
      {
        to: registration.token,
        title: 'Maestrly',
        body: phrase(registration.locale, 'test', this.deps.serverName()),
        data: { v: 1, device: deviceId, kind: 'test', id: null, category: null },
      },
    ])
    if (outcome?.ok) return
    if (!outcome || outcome.unregistered) this.deps.store.deletePushRegistration(deviceId)
    throw new GatewayError('INSTANCE_UNAVAILABLE', 'The push service did not take the notification')
  }

  private bot(botId: string, category: FleetPushCategory, key: Phrase, event: string): Promise<void> {
    const bot = this.deps.store.getBot(botId)
    if (!bot) return Promise.resolve()
    return this.send({ kind: 'bot', id: botId, name: bot.name }, category, key, `${key}:${event}`)
  }

  private async send(
    target: { kind: 'bot' | 'chat'; id: string; name: string },
    category: FleetPushCategory,
    key: Phrase,
    event: string
  ): Promise<void> {
    const now = this.now()
    const window = this.deps.windowMs ?? 20_000
    for (const [seen, at] of this.recent) if (now - at > window) this.recent.delete(seen)
    const recipients = this.deps.store.activePushRegistrations().filter(({ deviceId, registration }) => {
      if (!registration.preferences[category]) return false
      // A burst of the same news, such as a request seen again after a reconnect, notifies once.
      const seen = `${deviceId}\0${target.kind}\0${target.id}\0${key}\0${event}`
      if (this.recent.has(seen)) return false
      this.recent.set(seen, now)
      return true
    })
    if (!recipients.length) return
    const messages = recipients.map(({ deviceId, registration }) => ({
      to: registration.token,
      title: target.name.slice(0, 100) || 'Maestrly',
      body: phrase(registration.locale, key, this.deps.serverName()),
      data: { v: 1 as const, device: deviceId, kind: target.kind, id: target.id, category },
    }))
    let outcomes: PushOutcome[]
    try {
      outcomes = await this.deps.sender.send(messages)
    } catch {
      this.deps.log?.('Push notifications could not be sent')
      return
    }
    outcomes.forEach((outcome, index) => {
      if (!outcome.ok && outcome.unregistered) this.deps.store.deletePushRegistration(recipients[index].deviceId)
    })
  }
}

/** A sender for a server that sends no notifications. */
export const disabledPushSender: PushSender = {
  send: async (messages) => messages.map(() => ({ ok: false, unregistered: false })),
}
