import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetBotMemory } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'

export function BotMemorySection({ bot }: { bot: FleetBot }) {
  const { t } = useTranslation('fleet')
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
  return (
    <section className="space-y-3" aria-labelledby="fleet-bot-memory-heading">
      <h2 id="fleet-bot-memory-heading" className="font-semibold">
        {t('botMemory.heading')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('botMemory.description')}</p>
      <Button size="sm" variant="ghost" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
        {t(showArchived ? 'botMemory.hideArchived' : 'botMemory.showArchived')}
      </Button>
      {memories?.length === 0 && <p className="text-xs text-muted-foreground">{t('botMemory.empty')}</p>}
      <ul className="space-y-2">
        {memories?.map((memory) => (
          <li key={memory.id} className="space-y-2 rounded-lg border border-border bg-surface-elevated p-3 text-sm">
            <h3 className="font-medium">{memory.title}</h3>
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{t(`botMemory.type.${memory.type}`)}</span>
              <span className="rounded border border-border px-1.5">{t(`botMemory.source.${memory.source}`)}</span>
              {memory.pinned && <span className="text-primary">{t('botMemory.pinned')}</span>}
              {memory.status !== 'active' && (
                <span>{t(memory.status === 'superseded' ? 'ownerMemory.replaced' : 'ownerMemory.removed')}</span>
              )}
            </div>
            <p
              className={`whitespace-pre-wrap break-words text-xs text-muted-foreground ${expanded[memory.id] ? '' : 'line-clamp-3'}`}
            >
              {memory.content}
            </p>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={!!expanded[memory.id]}
              onClick={() => setExpanded((value) => ({ ...value, [memory.id]: !value[memory.id] }))}
            >
              {t(expanded[memory.id] ? 'botMemory.collapse' : 'botMemory.expand')}
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void mutate(() => window.api.fleetPatchBotMemory(bot.id, memory.id, { pinned: !memory.pinned }))
                }
              >
                {t(memory.pinned ? 'botMemory.unpin' : 'botMemory.pin')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    window.api.fleetPatchBotMemory(bot.id, memory.id, {
                      status: memory.status === 'active' ? 'archived' : 'active',
                    })
                  )
                }
              >
                {t(memory.status === 'active' ? 'botMemory.archive' : 'botMemory.restore')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(memory)}>
                {t('botMemory.delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
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
    </section>
  )
}
