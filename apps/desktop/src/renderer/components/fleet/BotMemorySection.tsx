import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, ArchiveRestore, Pin, PinOff, Trash2 } from 'lucide-react'
import { FLEET_BOT_MEMORY_LIMITS, type FleetBot, type FleetBotMemory } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { cn } from '@/lib/utils'
import { SavesNowTag, SettingsSection } from './SettingsSection'

/** Long enough that three lines may hide part of it. */
const longMemory = (memory: FleetBotMemory) =>
  memory.truncated || memory.content.length > 240 || memory.content.split('\n').length > 3

const iconButton =
  'flex size-[30px] shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

export function BotMemorySection({ bot, id = 'fleet-bot-memory' }: { bot: FleetBot; id?: string }) {
  const { t, i18n } = useTranslation('fleet')
  const [memories, setMemories] = useState<FleetBotMemory[] | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState<FleetBotMemory | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let alive = true
    void window.api
      .fleetListBotMemories(bot.id, showArchived ? 'all' : 'active')
      .then((value) => {
        if (alive) {
          setMemories(value.memories)
          setError('')
        }
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id, bot.status, showArchived, refresh])
  async function mutate(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      setConfirm(null)
      setRefresh((value) => value + 1)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  // Pinned memories first: they are the ones always in the bot's context.
  const sorted = memories && [...memories].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  return (
    <SettingsSection
      id={id}
      title={t('botMemory.heading')}
      note={t('botMemory.description')}
      aside={
        <>
          <SavesNowTag />
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((value) => !value)}
          >
            {t(showArchived ? 'botMemory.hideArchived' : 'botMemory.showArchived')}
          </Button>
        </>
      }
    >
      {sorted?.length === 0 ? (
        <div className="rounded-xl border border-border bg-foreground/[0.025] p-4 text-[13px] text-muted-foreground">
          {t('botMemory.empty')}
        </div>
      ) : (
        sorted && (
          <ul className="divide-y divide-border rounded-xl border border-border bg-foreground/[0.025]">
            {sorted.map((memory) => {
              const active = memory.status === 'active'
              return (
                <li key={memory.id} className="flex items-start gap-3 px-4 py-3">
                  <div className={cn('flex min-w-0 flex-1 flex-col gap-1', !active && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{t(`botMemory.type.${memory.type}`)}</span>
                      <span className="rounded border border-border px-1.5">
                        {t(`botMemory.source.${memory.source}`)}
                      </span>
                      {memory.pinned && (
                        <span className="inline-flex items-center gap-1 text-foreground">
                          <Pin className="size-3" aria-hidden="true" />
                          {t('botMemory.pinned')}
                        </span>
                      )}
                      {!active && (
                        <span>
                          {t(memory.status === 'superseded' ? 'ownerMemory.replaced' : 'ownerMemory.removed')}
                        </span>
                      )}
                    </div>
                    <h3 className="text-[13.5px] font-medium">{memory.title}</h3>
                    <p
                      className={cn(
                        'whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/75',
                        !expanded[memory.id] && 'line-clamp-3'
                      )}
                    >
                      {memory.content}
                    </p>
                    {memory.truncated && (
                      <p className="text-xs text-muted-foreground">
                        {t('botMemory.truncated', {
                          max: FLEET_BOT_MEMORY_LIMITS.contentMax.toLocaleString(i18n.language),
                        })}
                      </p>
                    )}
                    {longMemory(memory) && (
                      <button
                        type="button"
                        aria-expanded={!!expanded[memory.id]}
                        onClick={() => setExpanded((value) => ({ ...value, [memory.id]: !value[memory.id] }))}
                        className="self-start text-xs text-foreground/75 underline decoration-foreground/30 underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t(expanded[memory.id] ? 'botMemory.collapse' : 'botMemory.expand')}
                      </button>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      className={cn(iconButton, memory.pinned && 'text-foreground')}
                      aria-label={t(memory.pinned ? 'botMemory.unpin' : 'botMemory.pin')}
                      title={t(memory.pinned ? 'botMemory.unpin' : 'botMemory.pin')}
                      disabled={busy}
                      onClick={() =>
                        void mutate(() => window.api.fleetPatchBotMemory(bot.id, memory.id, { pinned: !memory.pinned }))
                      }
                    >
                      {memory.pinned ? (
                        <PinOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Pin className="size-4" aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={t(active ? 'botMemory.archive' : 'botMemory.restore')}
                      title={t(active ? 'botMemory.archive' : 'botMemory.restore')}
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          window.api.fleetPatchBotMemory(bot.id, memory.id, { status: active ? 'archived' : 'active' })
                        )
                      }
                    >
                      {active ? (
                        <Archive className="size-4" aria-hidden="true" />
                      ) : (
                        <ArchiveRestore className="size-4" aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className={cn(iconButton, 'hover:text-destructive')}
                      aria-label={t('botMemory.delete')}
                      title={t('botMemory.delete')}
                      disabled={busy}
                      onClick={() => setConfirm(memory)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('botMemory.deleteConfirm')}
          message={confirm.title}
          confirmLabel={t('botMemory.delete')}
          destructive
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirm(null)
          }}
          onConfirm={() => void mutate(() => window.api.fleetDeleteBotMemory(bot.id, confirm.id))}
        />
      )}
    </SettingsSection>
  )
}
