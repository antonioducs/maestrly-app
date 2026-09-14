import { Button } from '../../ui'
import { useEffect, useRef, useState } from 'react'
import type { Bot, BotInteraction, BotMessage, BotTurn } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import type { TranslationKey } from '../../i18n/pt-BR'
import { Composer } from './Composer'
import { FileCard, MessageList } from './MessageList'
import { Activity } from './Activity'
import { InteractionCard } from './InteractionCard'
import { useBotEvents } from './useBotEvents'
import { uploadFile, type Attachment } from './files'

export type ChatState = {
  text: string
  clientMessageId?: string
  attachments: Attachment[]
  messages: BotMessage[]
  turn?: BotTurn
  scrollTop: number
}
export function createChatState(botId: string): ChatState {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`chat:${botId}`) ?? '{}')
    return {
      text: saved.text ?? '',
      clientMessageId: saved.clientMessageId,
      attachments: saved.attachments ?? [],
      messages: [],
      scrollTop: 0,
    }
  } catch {
    return { text: '', attachments: [], messages: [], scrollTop: 0 }
  }
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
export function turnLabel(turn?: BotTurn): TranslationKey {
  if (!turn) return 'ready'
  return (
    {
      queued: 'queued',
      starting: 'working',
      running: 'working',
      waiting_approval: 'approval',
      waiting_input: 'question',
      cancelling: 'stopping',
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'stopped',
      interrupted: 'stopped',
      needs_attention: 'attention',
    } as const
  )[turn.status]
}
export function BotChat({
  bot,
  connected,
  state,
  details,
  onPreview,
  onBotUpdate,
}: {
  bot: Bot
  onBotUpdate: (bot: Bot) => void
  connected: boolean
  state: ChatState
  details: () => void
  onPreview: (name: string, text: string) => void
}) {
  const t = useT()
  const [, render] = useState(0)
  const [interactions, setInteractions] = useState<BotInteraction[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [replaceFile, setReplaceFile] = useState<Awaited<ReturnType<typeof window.bot.pickFile>>>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const active = !!state.turn && !terminal.has(state.turn.status)
  const changed = () => {
    sessionStorage.setItem(
      `chat:${bot.id}`,
      JSON.stringify({ text: state.text, clientMessageId: state.clientMessageId, attachments: state.attachments })
    )
    if (alive.current) render((value) => value + 1)
  }
  const refresh = async (earlier = false) => {
    const [page, pending, inspected] = await Promise.all([
      window.bot.bot({
        method: 'bot.messages.list',
        params: { botId: bot.id, ...(earlier && state.messages.length ? { before: state.messages[0].sequence } : {}) },
      }),
      window.bot.bot({ method: 'bot.interactions.list', params: { botId: bot.id, pendingOnly: true } }),
      window.bot.bot({ method: 'bot.inspect', params: { botId: bot.id } }),
    ])
    if (!alive.current) return
    const merged = new Map(state.messages.map((message) => [message.id, message]))
    for (const message of page.messages) merged.set(message.id, message)
    state.messages = [...merged.values()].sort((a, b) => a.sequence - b.sequence)
    if (!earlier) state.turn = page.turns.at(-1) ?? state.turn
    if (state.turn && !terminal.has(state.turn.status))
      state.turn = await window.bot.bot({ method: 'bot.turn.get', params: { turnId: state.turn.id } })
    if (!alive.current) return
    if (earlier || state.messages.length <= page.messages.length) setHasMore(page.hasMore)
    onBotUpdate(inspected)
    setInteractions(pending)
    changed()
  }
  useEffect(() => {
    alive.current = true
    if (scroll.current) scroll.current.scrollTop = state.scrollTop
    return () => {
      alive.current = false
    }
  }, [state])
  useEffect(() => {
    if (connected) void refresh().catch((error) => setError(String(error)))
  }, [bot.id, connected])
  const events = useBotEvents(bot.id, connected, refresh, (error) => setError(String(error)))
  const send = async () => {
    if (busy || active || !connected || !state.text.trim()) return
    setBusy(true)
    setError('')
    try {
      let receipt = state.clientMessageId
        ? await window.bot.bot({
            method: 'bot.messages.lookup',
            params: { botId: bot.id, clientMessageId: state.clientMessageId },
          })
        : null
      if (!receipt) {
        state.clientMessageId ??= crypto.randomUUID()
        changed()
        receipt = await window.bot.bot({
          method: 'bot.messages.send',
          params: {
            botId: bot.id,
            clientMessageId: state.clientMessageId,
            content: state.text,
            attachments: state.attachments,
          },
        })
      }
      state.turn = receipt.turn
      state.text = ''
      state.clientMessageId = undefined
      state.attachments = []
      changed()
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    if (!state.turn) return
    setBusy(true)
    setError('')
    try {
      try {
        state.turn = await window.bot.bot({
          method: 'bot.turn.cancel',
          params: { turnId: state.turn.id, expectedRevision: state.turn.revision },
        })
      } catch (error) {
        if (!/REVISION_CONFLICT|tarefa mudou/i.test(String(error))) throw error
        state.turn = await window.bot.bot({ method: 'bot.turn.get', params: { turnId: state.turn.id } })
        if (!terminal.has(state.turn.status))
          state.turn = await window.bot.bot({
            method: 'bot.turn.cancel',
            params: { turnId: state.turn.id, expectedRevision: state.turn.revision },
          })
      }
      changed()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const attach = async (replacement = false) => {
    setBusy(true)
    try {
      const file = replacement ? replaceFile : await window.bot.pickFile()
      if (!file) return
      try {
        state.attachments.push(await uploadFile(bot.id, file, replacement))
        setReplaceFile(null)
        changed()
      } catch (error) {
        if (/FILE_EXISTS|Já existe/i.test(String(error))) setReplaceFile(file)
        else throw error
      }
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="chat">
      <header className="chat-header" data-status={state.turn?.status}>
        <div>
          <h1>{bot.name}</h1>
          <p role="status" aria-live="polite">
            <span className="status-dot" />
            {state.turn?.status === 'needs_attention' ? state.turn.attention : t(turnLabel(state.turn))}
          </p>
        </div>
        <Button onClick={details}>{t('details')}</Button>
      </header>
      {state.turn?.status === 'needs_attention' && <Button onClick={() => void refresh()}>{t('checkAgain')}</Button>}
      <div
        className="messages"
        ref={scroll}
        onScroll={(event) => {
          state.scrollTop = event.currentTarget.scrollTop
        }}
      >
        {hasMore && (
          <Button onClick={() => void refresh(true).catch((error) => setError(String(error)))}>{t('previous')}</Button>
        )}
        {!state.messages.length && (
          <div className="empty-chat">
            <h2>{t('emptyChat')}</h2>
            <p>{t('emptyChatText')}</p>
          </div>
        )}
        <MessageList botId={bot.id} messages={state.messages} onPreview={onPreview} />
        {events
          .filter(
            (event) =>
              event.kind === 'file.produced' &&
              typeof event.detail?.path === 'string' &&
              typeof event.detail?.name === 'string' &&
              typeof event.detail?.size === 'number' &&
              !state.messages.some((message) => message.attachments.some((file) => file.path === event.detail?.path))
          )
          .map((event) => (
            <FileCard
              key={event.seq}
              botId={bot.id}
              file={{
                path: event.detail!.path as string,
                name: event.detail!.name as string,
                size: event.detail!.size as number,
              }}
              onPreview={onPreview}
            />
          ))}
        {interactions.map((interaction) => (
          <InteractionCard key={interaction.id} interaction={interaction} refresh={refresh} disabled={!connected} />
        ))}
        {state.turn?.status === 'failed' && (
          <div role="alert" className="task-error">
            <h3>{t('failed')}</h3>
            <p>{t('failedGuidance')}</p>
            {state.turn.error?.message && <details><summary>{t('technical')}</summary><pre>{state.turn.error.message}</pre></details>}
          </div>
        )}
        {events.length > 0 && <Activity events={events} />}
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <Composer
        attachments={state.attachments}
        removeAttachment={(path) => { state.attachments = state.attachments.filter(file => file.path !== path); changed() }}
        value={state.text}
        onChange={(value) => {
          state.text = value
          changed()
        }}
        send={() => void send()}
        stop={() => void stop()}
        attach={() => void attach()}
        active={active}
        cancelling={state.turn?.status === 'cancelling'}
        disabled={!connected}
        busy={busy}
      />
      {replaceFile && (
        <dialog
          ref={(node) => {
            if (node && !node.open) node.showModal()
          }}
          aria-labelledby="replace-title"
          onCancel={() => setReplaceFile(null)}
        >
          <h2 id="replace-title">{t('replace')}</h2>
          <p>{t('replaceWarning')}</p>
          <Button onClick={() => setReplaceFile(null)}>{t('cancel')}</Button>
          <Button onClick={() => void attach(true)}>{t('replace')}</Button>
        </dialog>
      )}
    </section>
  )
}
