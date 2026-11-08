/**
 * What the Realtime voice's tools do. The voice model never acts by itself: `ask_assistant` sends the person's own
 * words to the assistant conversation as their message, so the turn is the person's and the rules of the assistant
 * apply, and `answer_confirmation` only answers with the option the person just said aloud.
 */
import type { WebContents } from 'electron'
import { z } from 'zod'
import { type AssistantOverview, compactOverview } from '../../../shared/assistant-overview'
import type { PendingChatQuestion } from '../../../shared/chat'
import { tFor } from '../../../shared/i18n'
import type { SupportedLocale } from '../../../shared/locale'
import { toSpeakable } from '../../../shared/speakable'
import { matchSpokenOption } from '../../../shared/spoken-option'
import { REALTIME_TOOLS } from './session'

/** Marks the message as spoken, as the voice of the assistant window does. */
const VOICE_MARKER = '🎙 '
export const REALTIME_OVERVIEW_MAX = 3000
export const REALTIME_REPLY_MAX = 2000
const POLL_MS = 250
const SEND_TIMEOUT_MS = 30_000

export interface RealtimePendingQuestion {
  toolCallId: string
  question: string
  options: string[]
  /** Answered on the card only: an approval, or a question voice cannot answer. */
  clickOnly?: boolean
}

export interface RealtimeToolBridgeDeps {
  overview(): Promise<AssistantOverview>
  /** Sends the message in the assistant conversation as the person (chat:send). */
  sendAsPerson(text: string): Promise<{ messageId: string }>
  /** Waits for the turn of the message to end, or to ask the person something. */
  waitTurn(
    messageId: string,
    signal: AbortSignal
  ): Promise<{ reply: string; pendingQuestion: RealtimePendingQuestion | null }>
  answerQuestion(toolCallId: string, optionIndex: number): Promise<void>
  /** What the person said (transcribed) since the last ask_assistant or answer_confirmation. */
  lastPersonTranscripts(): string[]
  locale?: () => SupportedLocale
  now?: () => number
}

const json = (value: unknown) => JSON.stringify(value)

/** What needs the person, what runs and the bots, compact, within `max` characters. */
export function realtimeOverviewText(overview: AssistantOverview, now: number, max = REALTIME_OVERVIEW_MAX): string {
  const full = compactOverview(overview, now)
  const lists = {
    needsYou: (full.needsYou as unknown[] | undefined) ?? [],
    running: (full.running as unknown[] | undefined) ?? [],
    bots: (full.bots as unknown[] | undefined) ?? [],
  }
  let cut = false
  for (;;) {
    const text = json(cut ? { ...lists, truncated: true } : lists)
    if (text.length <= max) return text
    // Drop from the longest list's end: the most urgent and recent items come first.
    const longest = (Object.keys(lists) as Array<keyof typeof lists>).reduce((a, b) =>
      lists[a].length >= lists[b].length ? a : b
    )
    if (!lists[longest].length) return text.slice(0, max)
    lists[longest] = lists[longest].slice(0, -1)
    cut = true
  }
}

const askInput = z.object({ request: z.string().max(1000).optional() }).passthrough()
const answerInput = z.object({ option: z.string().max(300) }).passthrough()

export function createRealtimeToolBridge(deps: RealtimeToolBridgeDeps) {
  const locale = () => deps.locale?.() ?? 'en'
  /** The confirmation the last turn is waiting for, and the message whose turn it is. */
  let pending: (RealtimePendingQuestion & { messageId: string }) | null = null

  const follow = async (messageId: string, signal: AbortSignal): Promise<string> => {
    const turn = await deps.waitTurn(messageId, signal)
    const question = turn.pendingQuestion
    if (question?.clickOnly) return json({ confirmOnCard: question.question })
    if (question) {
      pending = { ...question, messageId }
      return json({ needsConfirmation: { question: question.question, options: question.options } })
    }
    return json({ reply: toSpeakable(turn.reply, locale()).slice(0, REALTIME_REPLY_MAX) })
  }

  return {
    async call(name: string, args: unknown, signal: AbortSignal): Promise<string> {
      if (!REALTIME_TOOLS.some((tool) => tool.name === name)) return json({ error: `Unknown tool: ${name}` })
      if (name === 'maestrly_overview') return realtimeOverviewText(await deps.overview(), deps.now?.() ?? Date.now())

      if (name === 'ask_assistant') {
        const parsed = askInput.safeParse(args ?? {})
        const request = parsed.success ? parsed.data.request?.trim() : undefined
        const heard = deps
          .lastPersonTranscripts()
          .map((text) => text.trim())
          .filter(Boolean)
          .join(' ')
        if (!heard) return json({ error: "The person's words did not come through. Ask them to say it again." })
        const summary = request ? `\n\n${tFor(locale(), 'main')('assistant.realtimeSummary', { request })}` : ''
        pending = null
        const { messageId } = await deps.sendAsPerson(`${VOICE_MARKER}${heard}${summary}`)
        return follow(messageId, signal)
      }

      // answer_confirmation
      if (!pending) return json({ error: 'No confirmation is waiting.' })
      const parsed = answerInput.safeParse(args ?? {})
      const said = deps.lastPersonTranscripts().at(-1) ?? ''
      const heardIndex = matchSpokenOption(said, pending.options, locale())
      const chosenIndex = parsed.success ? matchSpokenOption(parsed.data.option, pending.options, locale()) : null
      if (heardIndex === null || heardIndex !== chosenIndex) return json({ error: 'Ask the person to say the option' })
      const { toolCallId, messageId } = pending
      pending = null
      await deps.answerQuestion(toolCallId, heardIndex)
      return follow(messageId, signal)
    },
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true }
    )
  })

/** A card the voice can read: one question's first paragraph and its options. */
export function realtimeQuestion(pending: PendingChatQuestion, locale: SupportedLocale): RealtimePendingQuestion {
  const [only, ...rest] = pending.questions
  return {
    toolCallId: pending.toolCallId,
    question: toSpeakable((only?.question ?? '').split(/\n\s*\n/)[0], locale),
    options: only?.options.map((option) => option.label) ?? [],
    ...(!only || rest.length || only.multiSelect || only.isSecret || only.clickOnly || !only.options.length
      ? { clickOnly: true }
      : {}),
  }
}

/** The text the assistant answered with after the person's message `messageId`. */
function replyAfter(
  messages: ReadonlyArray<{ id: string; role: string; parts?: ReadonlyArray<{ type: string; text?: string }> }>,
  messageId: string
): string {
  const start = messages.findIndex((message) => message.id === messageId)
  if (start < 0) return ''
  return messages
    .slice(start + 1)
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!.trim())
    .join('\n\n')
}

/** The bridge's dependencies on this app: the assistant conversation shown in the window `wc`. */
export function assistantRealtimeBridgeDeps(opts: {
  wc: () => WebContents | null
  conversationId: () => Promise<string>
  heard: () => string[]
  locale: () => SupportedLocale
}): RealtimeToolBridgeDeps {
  return {
    locale: opts.locale,
    lastPersonTranscripts: opts.heard,
    async overview() {
      const [{ collectAssistantOverview }, conversationId] = await Promise.all([
        import('../assistant-context'),
        opts.conversationId(),
      ])
      return collectAssistantOverview(conversationId)
    },
    async sendAsPerson(text) {
      const [chat, { listChatMessages }, conversationId] = await Promise.all([
        import('../../chat/service'),
        import('../../chat/chat-store'),
        opts.conversationId(),
      ])
      const wc = opts.wc()
      if (!wc) throw new Error('The assistant window is closed.')
      const before = new Set(listChatMessages(conversationId).map((message) => message.id))
      let outcome: { ok: boolean; error?: string } | null = null
      const sent = chat.sendChatAsPerson(wc, conversationId, text).then((result) => {
        outcome = result
      })
      // The message is the person's once it is stored; the turn may run long after.
      const deadline = Date.now() + SEND_TIMEOUT_MS
      for (;;) {
        const fresh = listChatMessages(conversationId).find(
          (message) => message.role === 'user' && !before.has(message.id)
        )
        if (fresh) return { messageId: fresh.id }
        const result = outcome as { ok: boolean; error?: string } | null
        if (result && !result.ok) throw new Error(result.error ?? 'The message was not sent.')
        if (result || Date.now() > deadline) throw new Error('The message was not sent.')
        await Promise.race([sent, sleep(POLL_MS)])
      }
    },
    async waitTurn(messageId, signal) {
      const [chat, { listChatMessages }, conversationId] = await Promise.all([
        import('../../chat/service'),
        import('../../chat/chat-store'),
        opts.conversationId(),
      ])
      for (;;) {
        const [question] = chat.chatPendingInteractions(conversationId).questions
        if (question) return { reply: '', pendingQuestion: realtimeQuestion(question, opts.locale()) }
        if (!chat.isChatConversationRunning(conversationId))
          return { reply: replyAfter(listChatMessages(conversationId), messageId), pendingQuestion: null }
        await sleep(POLL_MS, signal)
      }
    },
    async answerQuestion(toolCallId, optionIndex) {
      const [chat, conversationId] = await Promise.all([import('../../chat/service'), opts.conversationId()])
      const pending = chat.chatPendingInteractions(conversationId).questions.find((q) => q.toolCallId === toolCallId)
      const label = pending?.questions[0]?.options[optionIndex]?.label
      if (!label) throw new Error('That confirmation is gone.')
      chat.replyChatQuestion(toolCallId, [[label]])
    },
  }
}
