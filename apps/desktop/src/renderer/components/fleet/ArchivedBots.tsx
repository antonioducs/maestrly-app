import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { FleetArchivedBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { fleetErrorText } from '@/lib/fleet/errors'
import { archivedBotPurge, hasEnvironments } from '@/lib/fleet/environments'
import type { FleetController } from '@/lib/fleet/use-fleet'

/**
 * Archived bots of the connected server: restore one on its kept files, or delete it forever. With environments,
 * this lists the bots archived from an active environment; an archived environment lists its bots itself.
 */
export function ArchivedBots({ fleet }: { fleet: FleetController }) {
  const { t, i18n } = useTranslation('fleet')
  const environments = hasEnvironments(fleet.state.connection)
  const [archived, setBots] = useState<FleetArchivedBot[] | null>(null)
  const active = new Set(fleet.state.snapshot.environments.map((environment) => environment.id))
  const bots =
    archived && environments
      ? archived.filter((bot) => bot.environmentId === null || active.has(bot.environmentId))
      : archived
  const [busy, setBusy] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<FleetArchivedBot | null>(null)
  const [typedName, setTypedName] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  // Another Mac may archive or restore a bot: a change in the active list is the cue to reload this one.
  const activeCount = fleet.state.snapshot.bots.length + fleet.state.snapshot.environments.length
  useEffect(() => {
    let alive = true
    void window.api
      .fleetListArchivedBots()
      .then((result) => alive && setBots(result.bots))
      .catch((cause) => alive && setError(fleetErrorText(cause, t)))
    return () => {
      alive = false
    }
  }, [activeCount, revision])
  const reload = () => setRevision((value) => value + 1)
  async function restore(bot: FleetArchivedBot) {
    setBusy(bot.id)
    setError('')
    try {
      const restored = await window.api.fleetRestoreArchivedBot(bot.id)
      fleet.dispatch({ type: 'event', value: { type: 'bot.updated', at: new Date().toISOString(), bot: restored } })
      setBots((current) => current?.filter((item) => item.id !== bot.id) ?? null)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
      reload()
    } finally {
      setBusy(null)
    }
  }
  async function deleteForever() {
    if (!deleting) return
    setBusy(deleting.id)
    setError('')
    try {
      await window.api.fleetDeleteArchivedBot(deleting.id)
      setBots((current) => current?.filter((item) => item.id !== deleting.id) ?? null)
      setDeleting(null)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
      reload()
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-labelledby="fleet-archived-heading">
      <h2 id="fleet-archived-heading" className="font-semibold">
        {environments ? t('server.archived.botsTitle') : t('server.archived.title')}
      </h2>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">
        {environments ? t('server.archived.botsDescription') : t('server.archived.description')}
      </p>
      {bots === null ? (
        !error && <p className="text-xs text-muted-foreground">{t('server.archived.loading')}</p>
      ) : bots.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('server.archived.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-elevated">
          {bots.map((bot) => (
            <li key={bot.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: bot.tint }} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {bot.name}
                  {bot.role && <span className="font-normal text-muted-foreground"> · {bot.role}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('server.archived.archivedAt', {
                    date: new Date(bot.archivedAt).toLocaleDateString(i18n.language, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  })}{' '}
                  ·{' '}
                  {bot.files === 'kept' ? (
                    t('server.archived.filesKept')
                  ) : (
                    <span className="text-amber-500">{t('server.archived.filesMissing')}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  aria-label={t('server.archived.restoreLabel', { name: bot.name })}
                  onClick={() => void restore(bot)}
                >
                  {busy === bot.id && !deleting && <Loader2 className="animate-spin" />}
                  {t('server.archived.restore')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy !== null}
                  aria-label={t('server.archived.deleteLabel', { name: bot.name })}
                  onClick={() => {
                    setTypedName('')
                    setDeleting(bot)
                  }}
                >
                  {t('server.archived.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('server.archived.deleteTitle', { name: deleting?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {/* In a shared environment only the bot's own data goes; its environment keeps the rest. */}
              {deleting && archivedBotPurge(deleting, fleet.state.snapshot.environments, environments) === 'bot'
                ? t('server.archived.deleteDescriptionEnvironment', { name: deleting.name })
                : t('server.archived.deleteDescription', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {/* Typing the name keeps an irreversible delete from being one Enter away. */}
          <label className="block text-sm">
            {t('server.archived.deleteConfirmLabel', { name: deleting?.name ?? '' })}
            <Input
              className="mt-1"
              value={typedName}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTypedName(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={busy !== null} onClick={() => setDeleting(null)}>
              {t('server.archived.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null || typedName.trim() !== deleting?.name}
              onClick={() => void deleteForever()}
            >
              {busy !== null && <Loader2 className="animate-spin" />}
              {t('server.archived.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
