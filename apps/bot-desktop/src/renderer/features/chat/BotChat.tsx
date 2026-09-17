import { Button } from '../../ui'
import { useEffect, useRef, useState } from 'react'
import type { Bot, BotInteraction, BotTurn } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import type { TranslationKey } from '../../i18n/pt-BR'
import { ChatContextMeter, TranscriptList, useStickToBottom } from '@maestrly/chat-ui'
import type { TranscriptMessage } from '@maestrly/host-protocol'
import { Composer } from './Composer'
import { FileCard } from './FileCard'
import { botUrlTransform } from './BotMarkdown'
import { useTranscript } from './useTranscript'
import { useContextMeter } from './useContextMeter'
import { expandMessage, usePrompts } from '../prompts/usePrompts'
import { useExtensions } from '../extensions/useExtensions'
import { InteractionCard } from './InteractionCard'
import { useBotEvents } from './useBotEvents'
import { uploadFile, type Attachment } from './files'
import { DollarSign, Monitor } from 'lucide-react'
import { BotUsageDialog } from '../usage/BotUsageDialog'
import { useDesktopState } from '../desktop/useDesktopState'
import { VoiceComposer } from '../voice/VoiceComposer'
import { VoiceMessage } from '../voice/VoiceMessage'
import { ProposalStrip } from '../routines/ProposalStrip'
import type { VoiceMessageMeta } from '@maestrly/host-protocol'

export type ChatState = {
  text: string
  clientMessageId?: string
  attachments: Attachment[]
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
      scrollTop: 0,
    }
  } catch {
    return { text: '', attachments: [], scrollTop: 0 }
  }
}
function SystemNotice({ content }: { content: string }) {
  const t = useT()
  return (
    <>
      <p className="system-title">{t('continuationNotice')}</p>
      <details>
        <summary>{t('continuationDetails')}</summary>
        <p>{content}</p>
      </details>
    </>
  )
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
  onOpenDesktop,
  desktopOpen = false,
  hostId = '',
  voiceSupported = false,
  routinesSupported = false,
  chatSupported = false,
}: {
  bot: Bot
  onBotUpdate: (bot: Bot) => void
  connected: boolean
  state: ChatState
  details: () => void
  onPreview: (name: string, text: string) => void
  onOpenDesktop?: () => void
  desktopOpen?: boolean
  hostId?: string
  /** Advertised by the Host only when it can actually transcribe. */
  voiceSupported?: boolean
  routinesSupported?: boolean
  /** The Host folds transcripts (tool cards, reasoning); without it the app shows plain messages. */
  chatSupported?: boolean
}) {
  const t = useT()
  const [, render] = useState(0)
  const [interactions, setInteractions] = useState<BotInteraction[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [replaceFile, setReplaceFile] = useState<Awaited<ReturnType<typeof window.bot.pickFile>>>(null)
  const [usageOpen, setUsageOpen] = useState(false)
  // Sidecar metadata for messages that came from a recording; absent for typed ones.
  const [voiceMeta, setVoiceMeta] = useState<Record<string, VoiceMessageMeta>>({})
  const alive = useRef(true)
  const active = !!state.turn && !terminal.has(state.turn.status)
  const [desktop, setDesktop] = useDesktopState(bot.id, connected, desktopOpen)
  const held = !!desktop && desktop.mode !== 'bot'
  const continueBot = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await window.bot.desktop.returnControl({ botId: bot.id, continueTask: true })
      setDesktop(result.state)
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const changed = () => {
    sessionStorage.setItem(
      `chat:${bot.id}`,
      JSON.stringify({ text: state.text, clientMessageId: state.clientMessageId, attachments: state.attachments })
    )
    if (alive.current) render((value) => value + 1)
  }
  const events = useBotEvents(bot.id, connected, () => refresh(), (error) => setError(String(error)))
  const transcript = useTranscript(bot.id, connected, chatSupported, events)
  const meter = useContextMeter(transcript.turns, bot.model?.model)
  const { prompts, commands } = usePrompts(bot.id, connected, chatSupported)
  const extensions = useExtensions(bot.id, connected, chatSupported)
  const enabledServers = extensions.state.mcpServers.filter((server) => server.enabled).length
  const enabledSkills = extensions.state.skills.filter((skill) => skill.enabled).length
  const refresh = async () => {
    const [pending, inspected] = await Promise.all([
      window.bot.bot({ method: 'bot.interactions.list', params: { botId: bot.id, pendingOnly: true } }),
      window.bot.bot({ method: 'bot.inspect', params: { botId: bot.id } }),
      transcript.reload(),
    ])
    if (!alive.current) return
    const activeTurn = inspected.activeTurnId ?? state.turn?.id
    if (activeTurn) state.turn = await window.bot.bot({ method: 'bot.turn.get', params: { turnId: activeTurn } })
    if (!alive.current) return
    onBotUpdate(inspected)
    setInteractions(pending)
    changed()
  }
  const persistedIds = transcript.messages.filter((message) => message.role === 'user').map((message) => message.id)
  useEffect(() => {
    if (!voiceSupported || !connected || !persistedIds.length) return
    let cancelled = false
    window.bot.voice
      .call({ method: 'voice.forMessages', params: { target: { kind: 'bot', id: bot.id }, messageIds: persistedIds.slice(-100) } })
      .then((metas) => {
        if (!cancelled && alive.current) setVoiceMeta(Object.fromEntries(metas.map((meta) => [meta.messageId, meta])))
      })
      .catch(() => {
        /* a Host without voice simply has no recordings to describe */
      })
    return () => {
      cancelled = true
    }
  }, [voiceSupported, connected, bot.id, persistedIds.join(',')])
  // Opens at the end and follows new content only while the person is already reading the end.
  const lastMessage = transcript.messages.at(-1)
  const { ref: scroll, onScroll } = useStickToBottom<HTMLDivElement>(
    `${transcript.messages.length}:${lastMessage?.id}:${lastMessage?.parts.length}:${(() => { const last = lastMessage?.parts.at(-1); return last && last.type === 'text' ? last.text.length : '' })()}`,
    state.scrollTop
  )
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [state])
  useEffect(() => {
    if (connected) void refresh().catch((error) => setError(String(error)))
  }, [bot.id, connected])
  const send = async () => {
    if (busy || active || held || !connected || !state.text.trim()) return
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
            // A stored command is expanded here, in the application: the Host receives plain text.
            content: expandMessage(state.text, prompts),
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
        <div className="chat-header-actions">
          {onOpenDesktop && (
            <Button aria-pressed={desktopOpen} onClick={onOpenDesktop}>
              <Monitor size={15} aria-hidden="true" />
              {t('viewScreen')}
            </Button>
          )}
          {chatSupported && (
            <Button aria-label={t('usageOf').replace('{name}', bot.name)} title={t('usage')} onClick={() => setUsageOpen(true)}>
              <DollarSign size={15} aria-hidden="true" />
            </Button>
          )}
          <Button onClick={details}>{t('details')}</Button>
        </div>
      </header>
      {chatSupported && <BotUsageDialog bot={bot} open={usageOpen} onOpenChange={setUsageOpen} connected={connected} supported={chatSupported} />}
      {held && !desktopOpen && (
        <div className="desktop-banner" role="status">
          <p>{t(desktop?.mode === 'blocked' ? 'blockedBanner' : 'pausedBanner')}</p>
          {(desktop?.mode === 'paused' || desktop?.mode === 'blocked') && (
            <Button className="primary" disabled={busy || !connected} onClick={() => void continueBot()}>{t('continueBot')}</Button>
          )}
          {onOpenDesktop && <Button onClick={onOpenDesktop}>{t('viewScreen')}</Button>}
        </div>
      )}
      {state.turn?.status === 'needs_attention' && <Button onClick={() => void refresh()}>{t('checkAgain')}</Button>}
      {connected && !chatSupported && (
        <p className="alert" role="status">
          {t('chatHostOutdated')}
        </p>
      )}
      <div
        className="messages"
        ref={scroll}
        onScroll={(event) => {
          state.scrollTop = event.currentTarget.scrollTop
          onScroll()
        }}
      >
        {transcript.hasMore && (
          <Button onClick={() => void transcript.loadEarlier().catch((error) => setError(String(error)))}>{t('previous')}</Button>
        )}
        {!transcript.messages.length && (
          <div className="empty-chat">
            <h2>{t('emptyChat')}</h2>
            <p>{t('emptyChatText')}</p>
          </div>
        )}
        <TranscriptList<TranscriptMessage>
          messages={transcript.messages}
          urlTransform={botUrlTransform}
          allowImages={false}
          slots={{
            system: (message) => <SystemNotice content={message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n')} />,
            // A produced file that is also an attachment of the answer is shown once, as the attachment.
            file: (part, message) =>
              message.attachments.some((file) => file.path === part.path) ? null : (
                <FileCard botId={bot.id} file={{ path: part.path!, name: part.name!, size: part.size ?? 0 }} onPreview={onPreview} />
              ),
            after: (message) => (
              <>
                {(() => {
                  const meta = voiceMeta[message.id]
                  return meta ? <VoiceMessage meta={meta} read={(clipId) => window.bot.voice.read({ clipId })} /> : null
                })()}
                {message.attachments.map((file) => (
                  <FileCard key={file.path} botId={bot.id} file={file} onPreview={onPreview} />
                ))}
              </>
            ),
          }}
        />
        {/* Suggestions the bot left, where it left them. Each one is inert until confirmed. */}
        <ProposalStrip
          target={{ kind: 'bot', id: bot.id }}
          targetName={bot.name}
          connected={connected}
          supported={routinesSupported}
          onActivated={() => void refresh()}
        />
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
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <Composer
        bot={bot}
        onBotUpdate={onBotUpdate}
        connected={connected}
        metaSlot={<ChatContextMeter usage={meter.usage} meta={meter.meta} cost={meter.cost} />}
        commands={commands}
        onPickCommand={(command) => {
          state.text = `/${command.name} `
          changed()
        }}
        leftExtra={
          // What this bot carries into the turn, at a glance; the details tab is where it changes.
          enabledServers + enabledSkills > 0 ? (
            <Button className="extension-chip" aria-label={t('extensions')} title={t('extensions')} onClick={details}>
              {enabledServers > 0 && <span>MCP: {enabledServers}</span>}
              {enabledSkills > 0 && <span>{t('skills')}: {enabledSkills}</span>}
            </Button>
          ) : undefined
        }
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
        disabled={!connected || held}
        reason={connected && held ? t('composerHeldReason') : undefined}
        busy={busy}
        voice={
          <VoiceComposer
            target={{ kind: 'bot', id: bot.id }}
            targetName={bot.name}
            hostId={hostId}
            connected={connected}
            supported={voiceSupported}
            disabled={!connected || held || active}
            busy={busy}
            onSent={() => refresh()}
          />
        }
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
