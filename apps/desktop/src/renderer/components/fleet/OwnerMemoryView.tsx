import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FLEET_OWNER_MEMORY_LIMITS,
  type FleetOwnerMemory,
  type FleetOwnerMemoryEntry,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import type { FleetController } from '@/lib/fleet/use-fleet'

export function OwnerMemoryView({ fleet, onOpenBot }: { fleet: FleetController; onOpenBot: (id: string) => void }) {
  const { t, i18n } = useTranslation('fleet')
  const [memory, setMemory] = useState<FleetOwnerMemory | null>(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [confirm, setConfirm] = useState<FleetOwnerMemoryEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const connected = fleet.state.connection.state === 'connected'
  useEffect(() => {
    if (!connected) return
    let alive = true
    void window.api
      .fleetOwnerMemoryList('all')
      .then((value) => {
        if (alive) {
          setMemory(value)
          setError('')
        }
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [connected, fleet.state.ownerMemoryRevision, refresh])

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
  const active = memory?.entries.filter((entry) => entry.status === 'active') ?? []
  const history = memory?.entries.filter((entry) => entry.status !== 'active') ?? []
  function row(entry: FleetOwnerMemoryEntry) {
    const author = entry.author
    return (
      <li key={entry.id} className="space-y-2 rounded-lg border border-border bg-surface-elevated p-4 text-sm">
        {editing?.id === entry.id ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              void mutate(async () => {
                await window.api.fleetOwnerMemoryUpdate(entry.id, { content: editing.content.trim() })
                setEditing(null)
              })
            }}
          >
            <textarea
              className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('ownerMemory.edit')}
              value={editing.content}
              maxLength={FLEET_OWNER_MEMORY_LIMITS.entryMax}
              onChange={(event) => setEditing({ id: entry.id, content: event.target.value })}
            />
            <Button size="sm" type="submit" disabled={busy || !editing.content.trim()}>
              {t('ownerMemory.save')}
            </Button>
            <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              {t('ownerMemory.cancel')}
            </Button>
          </form>
        ) : (
          <p className="whitespace-pre-wrap break-words">{entry.content}</p>
        )}
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {author.kind === 'owner' ? (
            t('ownerMemory.authorOwner')
          ) : (
            <button type="button" className="text-primary hover:underline" onClick={() => onOpenBot(author.botId)}>
              {author.name}
            </button>
          )}
          {entry.origin && <span>· {t(`ownerMemory.origin.${entry.origin}`)}</span>}
          <time dateTime={entry.createdAt}>· {new Date(entry.createdAt).toLocaleDateString(i18n.language)}</time>
          {entry.status !== 'active' && (
            <span>· {t(entry.status === 'superseded' ? 'ownerMemory.replaced' : 'ownerMemory.removed')}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {entry.status === 'active' ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing({ id: entry.id, content: entry.content })}
              >
                {t('ownerMemory.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void mutate(() => window.api.fleetOwnerMemoryUpdate(entry.id, { status: 'archived' }))}
              >
                {t('ownerMemory.archive')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void mutate(() => window.api.fleetOwnerMemoryUpdate(entry.id, { status: 'active' }))}
            >
              {t('ownerMemory.restore')}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(entry)}>
            {t('ownerMemory.delete')}
          </Button>
        </div>
      </li>
    )
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold">{t('ownerMemory.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('ownerMemory.description')}</p>
        </header>
        {!connected ? (
          <p className="text-sm text-muted-foreground">{t('ownerMemory.unavailable')}</p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('ownerMemory.usage', {
                  used: memory?.activeChars ?? 0,
                  max: FLEET_OWNER_MEMORY_LIMITS.activeCharsMax,
                })}
              </p>
              <div
                role="meter"
                aria-label={t('ownerMemory.title')}
                aria-valuenow={memory?.activeChars ?? 0}
                aria-valuemin={0}
                aria-valuemax={FLEET_OWNER_MEMORY_LIMITS.activeCharsMax}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary"
                  style={{
                    width: `${Math.min(100, ((memory?.activeChars ?? 0) / FLEET_OWNER_MEMORY_LIMITS.activeCharsMax) * 100)}%`,
                  }}
                />
              </div>
            </div>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                void mutate(async () => {
                  await window.api.fleetOwnerMemoryCreate({ content: content.trim() })
                  setContent('')
                })
              }}
            >
              <textarea
                className="min-h-24 w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('ownerMemory.add')}
                placeholder={t('ownerMemory.addPlaceholder')}
                maxLength={FLEET_OWNER_MEMORY_LIMITS.entryMax}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
              <Button type="submit" disabled={busy || !content.trim()}>
                {t('ownerMemory.add')}
              </Button>
            </form>
            <ul className="space-y-3">{active.map(row)}</ul>
            {memory && !active.length && <p className="text-sm text-muted-foreground">{t('ownerMemory.empty')}</p>}
            {history.length > 0 && (
              <section className="space-y-3">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showHistory}
                  onClick={() => setShowHistory((value) => !value)}
                >
                  {t(showHistory ? 'ownerMemory.hideHistory' : 'ownerMemory.showHistory', { count: history.length })}
                </Button>
                {showHistory && (
                  <>
                    <h2 className="text-sm font-semibold">{t('ownerMemory.history')}</h2>
                    <ul className="space-y-3">{history.map(row)}</ul>
                  </>
                )}
              </section>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={t('ownerMemory.deleteConfirm')}
          message={confirm.content}
          confirmLabel={t('ownerMemory.delete')}
          destructive
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirm(null)
          }}
          onConfirm={() => void mutate(() => window.api.fleetOwnerMemoryDelete(confirm.id))}
        />
      )}
    </section>
  )
}
