import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wrench, X } from 'lucide-react'
import type { FleetBot, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { takeoverBlocksResume } from '@/lib/fleet/selectors'
import { visibleTranscriptItems } from '@/lib/fleet/forms'
import { InteractionCard } from './InteractionCard'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { fleetImageCache, type FleetImageCache } from '@/lib/fleet/image-cache'
import { BotComposer } from './BotComposer'
import { BotTranscriptImages } from './BotTranscriptImages'

function TranscriptRow({
  bot,
  item,
  fleet,
  onOpenBot,
  onOpenScreen,
  imageCache,
}: {
  bot: FleetBot
  imageCache: FleetImageCache
  item: FleetTranscriptItem
  fleet: FleetController
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const at = new Date(item.at).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (item.kind === 'user') {
    if (item.source === 'peer')
      return (
        <div className="rounded-lg border border-dashed border-border p-3 text-sm">
          <div className="mb-1 text-xs text-muted-foreground">
            {t('transcript.peerWrote', {
              name: item.peer?.name ?? '',
              bot: bot.name,
            })}{' '}
            · {at}
          </div>
          {item.text}
          {item.memories.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('conversation.recalled', { titles: item.memories.map((memory) => memory.title).join(', ') })}
            </p>
          )}
          {item.peer && fleet.state.snapshot.bots.some((peer) => peer.id === item.peer?.botId) && (
            <button
              type="button"
              className="ml-2 text-primary hover:underline"
              onClick={() => onOpenBot(item.peer!.botId)}
            >
              {t('transcript.openPeer')}
            </button>
          )}
        </div>
      )
    return (
      <div className="ml-auto max-w-[85%] rounded-xl border border-border-strong bg-surface-elevated px-4 py-3 text-sm">
        {item.source === 'routine' && (
          <span className="mb-2 block text-xs text-primary">
            {t('transcript.routine', {
              title: item.routine?.title ?? '',
              time: at,
            })}
          </span>
        )}
        <p className="whitespace-pre-wrap">{item.text}</p>
        {item.memories.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('conversation.recalled', { titles: item.memories.map((memory) => memory.title).join(', ') })}
          </p>
        )}
        <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
        <span className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {at}
          {item.queued && (
            <>
              {t('transcript.queued')}
              <button
                type="button"
                aria-label={t('transcript.removeQueued')}
                className="rounded p-0.5 hover:text-destructive"
                onClick={() =>
                  void window.api
                    .fleetRemoveQueuedMessage(bot.id, item.id.replace(/^input:/, ''))
                    .then(() => fleet.loadTranscript(bot.id))
                    .catch(() => {})
                }
              >
                <X className="size-3" />
              </button>
            </>
          )}
        </span>
      </div>
    )
  }
  if (item.kind === 'assistant')
    return (
      <div className="max-w-[90%] text-sm">
        <MarkdownViewer markdown={item.text} />
        {item.streaming && <span className="text-xs text-muted-foreground">{t('transcript.streaming')}</span>}
        <span className="mt-1 block text-xs text-muted-foreground">{at}</span>
      </div>
    )
  if (item.kind === 'compaction')
    return (
      <div className="my-1 flex min-w-0 max-w-full flex-col gap-2">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          <span className="h-px flex-1 bg-white/[0.1]" />
          {t('transcript.compaction.heading')}
          <span className="h-px flex-1 bg-white/[0.1]" />
        </div>
        <p className="text-center text-xs text-muted-foreground">{t(`transcript.compaction.${item.origin}`)}</p>
        {item.origin === 'runtime' ? (
          <p className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-xs text-muted-foreground">
            {t('chat:messages.nativeContextCheckpoint')}
          </p>
        ) : item.summary ? (
          <details className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('chat:messages.previousContextSummary')}
            </summary>
            <div className="mt-2 text-sm text-muted-foreground">
              <MarkdownViewer markdown={item.summary} />
            </div>
            {item.truncated && (
              <p className="mt-2 text-xs text-muted-foreground">{t('transcript.compaction.truncated')}</p>
            )}
          </details>
        ) : null}
      </div>
    )
  if (item.kind === 'tool')
    return (
      <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {item.state === 'running' ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <Wrench className="size-3" />
          )}
          <code className="text-foreground">{item.name}</code>
          <span className="truncate">{item.target}</span>
          <span className="ml-auto">
            {t(
              `transcript.tool.${item.state === 'running' && (bot.status === 'paused' || bot.status === 'human') ? 'paused' : item.state}`
            )}
          </span>
        </div>
        <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
      </div>
    )
  if (item.kind === 'permission' || item.kind === 'question' || item.kind === 'help')
    return <InteractionCard botId={bot.id} item={item} fleet={fleet} onOpenScreen={onOpenScreen} />
  if (item.kind === 'peer_out')
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-sm">
        <div className="text-xs text-muted-foreground">
          {t('transcript.wroteTo', { bot: item.to.name })} · {at}
        </div>
        <p className="mt-1">{item.text}</p>
        <span className="text-xs text-muted-foreground">
          {t(item.delivered ? 'transcript.delivered' : 'transcript.notDelivered')}
        </span>
      </div>
    )
  return (
    <div className="text-center text-xs text-muted-foreground">
      {t(`transcript.system.${item.code}`, {
        duration: item.durationMs ? Math.round(item.durationMs / 1000) : 0,
      })}
      {item.text && <span className="ml-1">{item.text}</span>}
    </div>
  )
}

export function BotConversation({
  bot,
  fleet,
  onOpenBot,
  onOpenScreen,
  onOpenSettings,
}: {
  bot: FleetBot
  fleet: FleetController
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('fleet')
  const transcript = fleet.state.transcripts[bot.id]
  const imageCache = fleetImageCache
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const oldHeightRef = useRef<number | null>(null)
  useEffect(() => {
    fleet.ensureTranscript(bot.id)
  }, [bot.id, fleet.ensureTranscript])
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (oldHeightRef.current !== null) {
      node.scrollTop += node.scrollHeight - oldHeightRef.current
      oldHeightRef.current = null
    } else if (atBottomRef.current) node.scrollTop = node.scrollHeight
  }, [transcript?.items])
  const locked = ['paused', 'human', 'offline', 'starting', 'setup'].includes(bot.status)
  const lastItem = transcript?.items.at(-1)
  const runningToolLast = lastItem?.kind === 'tool' && lastItem.state === 'running'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget
          atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {transcript?.error && (
            <div role="alert" className="text-center text-xs text-destructive">
              {transcript.error}{' '}
              <button
                type="button"
                className="ml-2 text-primary underline"
                onClick={() => void fleet.loadTranscript(bot.id).catch(() => {})}
              >
                {t('transcript.retry')}
              </button>
            </div>
          )}
          {transcript?.before && (
            <button
              type="button"
              disabled={transcript.loading}
              className="self-center rounded-md border border-border px-3 py-1.5 text-xs"
              onClick={() => {
                oldHeightRef.current = scrollRef.current?.scrollHeight ?? null
                void fleet
                  .loadTranscript(bot.id, transcript.before)
                  .catch((cause) => setError(fleetErrorMessage(cause)))
              }}
            >
              {t('transcript.loadOlder')}
            </button>
          )}
          {visibleTranscriptItems(transcript?.items ?? []).map((item) => (
            <TranscriptRow
              key={item.id}
              bot={bot}
              item={item}
              fleet={fleet}
              onOpenBot={onOpenBot}
              onOpenScreen={onOpenScreen}
              imageCache={imageCache}
            />
          ))}
          {bot.status === 'working' && !runningToolLast && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
              {t('transcript.working')}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {locked && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-elevated p-3 text-sm text-muted-foreground">
              <span>
                {bot.status === 'setup' && bot.activity?.kind === 'setup' && bot.activity.need === 'compaction'
                  ? t('composer.setupCompaction')
                  : t(`composer.${bot.status}`)}
              </span>
              {bot.status === 'offline' && (
                <button type="button" className="text-primary" onClick={() => void fleet.botAction(bot.id, 'start')}>
                  {t('action.start')}
                </button>
              )}
              {bot.status === 'paused' && (
                <button
                  type="button"
                  className="text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={takeoverBlocksResume(bot.takeover)}
                  title={takeoverBlocksResume(bot.takeover) ? t('action.resumeBlocked') : undefined}
                  onClick={() => void fleet.botAction(bot.id, 'resume')}
                >
                  {t('action.resume')}
                </button>
              )}
              {bot.status === 'setup' &&
                (bot.activity?.kind === 'setup' && bot.activity.need === 'compaction' ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <button type="button" className="text-primary" onClick={onOpenSettings}>
                      {t('composer.chooseCompactionModel')}
                    </button>
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-2">
                    <button type="button" className="text-primary" onClick={onOpenScreen}>
                      {t('composer.connectAccount')}
                    </button>
                    <button type="button" className="text-primary" onClick={onOpenSettings}>
                      {t('composer.addApiKeyInSettings')}
                    </button>
                  </span>
                ))}
            </div>
          )}
          <BotComposer bot={bot} fleet={fleet} onOpenScreen={onOpenScreen} onOpenSettings={onOpenSettings} />
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
