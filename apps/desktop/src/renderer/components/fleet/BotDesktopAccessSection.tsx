import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleCheck, Laptop } from 'lucide-react'
import { FLEET_DESKTOP_BRIDGE_LIMITS, type FleetBot, type FleetDesktopLinkView } from '@maestrly/bot-fleet-protocol'
import type { FleetDesktopAccessInput, FleetDesktopAccessView } from '../../../shared/fleet-desktop-access'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { BotGrantFields } from '@/components/bot/BotGrantFields'
import {
  BOT_ACTION_NAMES,
  SUGGESTED_BOT_PERMISSION_CEILING,
  type BotProviderOption,
  type BotWorkspaceOption,
} from '@/components/bot/config'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { cn } from '@/lib/utils'
import { SettingsCard, SettingsSection } from './SettingsSection'
import { SettingsSwitch } from './SettingsSwitch'

const fieldInput =
  'w-full rounded-[9px] border border-input bg-black/25 px-3 py-2 text-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-[invalid=true]:border-destructive'

const same = (a: FleetDesktopAccessInput, b: FleetDesktopAccessInput) =>
  a.macName.trim() === b.macName.trim() &&
  a.permissionCeiling === b.permissionCeiling &&
  [...a.workspaceIds].sort().join('\n') === [...b.workspaceIds].sort().join('\n') &&
  [...a.actions].sort().join('\n') === [...b.actions].sort().join('\n') &&
  a.selections
    .map((item) => item.providerId + '\0' + item.modelId)
    .sort()
    .join('\n') ===
    b.selections
      .map((item) => item.providerId + '\0' + item.modelId)
      .sort()
      .join('\n')

/**
 * What this computer gives one fleet bot: the projects it may start development conversations in, the models and actions
 * it may use and how far it may go, under a name the bot sees; and the other computers that gave it access, whose access
 * can only be removed from here. Changes are saved with this section's own button, apart from the bot's settings.
 */
export function BotDesktopAccessSection({ bot, id }: { bot: FleetBot; id: string }) {
  const { t, i18n } = useTranslation('fleet')
  const [view, setView] = useState<FleetDesktopAccessView | null>(null)
  const [workspaces, setWorkspaces] = useState<BotWorkspaceOption[]>([])
  const [providers, setProviders] = useState<BotProviderOption[]>([])
  /** The form while the person gives access or changes it; null when nothing is being edited. */
  const [draft, setDraft] = useState<FleetDesktopAccessInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState<
    { kind: 'disable' } | { kind: 'remove'; link: FleetDesktopLinkView } | null
  >(null)

  const refresh = useCallback(async () => {
    const next = await window.api.fleetDesktopAccess(bot.id)
    setView(next)
    return next
  }, [bot.id])
  useEffect(() => {
    let alive = true
    setDraft(null)
    setSaved(false)
    setError('')
    void Promise.all([
      window.api.fleetDesktopAccess(bot.id),
      window.api.listWorkspaces(),
      window.api.platformExecutorProviders(),
    ])
      .then(([access, projects, accounts]) => {
        if (!alive) return
        setView(access)
        setWorkspaces(projects)
        setProviders(accounts)
      })
      .catch((cause) => {
        if (alive) setError(fleetErrorMessage(cause))
      })
    return () => {
      alive = false
    }
  }, [bot.id])
  // Another computer removed this one, the bot was deleted, or this computer reconnected: read it again.
  useEffect(
    () =>
      window.api.onFleetDesktopAccess(({ botId }) => {
        if (botId === bot.id) void refresh().catch(() => undefined)
      }),
    [bot.id, refresh]
  )

  async function perform(action: () => Promise<FleetDesktopAccessView>, after?: () => void) {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      setView(await action())
      after?.()
      return true
    } catch (cause) {
      setError(fleetErrorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const access = view?.access ?? null
  const form: FleetDesktopAccessInput | null = draft ?? access
  const editing = draft !== null
  const dirty = !!draft && (!access || !same(draft, access))
  const blockers = form
    ? [
        ...(!form.macName.trim() ? [t('botSettings.desktops.nameRequired')] : []),
        ...(!workspaces.length
          ? [t('ui:bots.blockers.noProjects')]
          : !form.workspaceIds.length
            ? [t('ui:bots.blockers.projects')]
            : []),
        ...(!providers.length
          ? [t('ui:bots.blockers.noModels')]
          : !form.selections.length
            ? [t('ui:bots.blockers.models')]
            : []),
        ...(!form.actions.length ? [t('ui:bots.blockers.actions')] : []),
      ]
    : []
  const others = view?.links?.filter((link) => !link.self) ?? []
  const date = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
  const edit = (patch: Partial<FleetDesktopAccessInput>) => {
    if (!form) return
    setDraft({ ...form, ...patch })
    setSaved(false)
  }

  return (
    <SettingsSection id={id} title={t('botSettings.desktops.title')} note={t('botSettings.desktops.note')}>
      <div className="flex flex-col gap-6" data-testid="fleet-desktop-access">
        {!view ? (
          <p className="text-sm text-muted-foreground">{error || t('botSettings.desktops.loading')}</p>
        ) : (
          <>
            {view.availability !== 'ready' && (
              <p
                role="status"
                data-testid="fleet-desktop-access-unavailable"
                className="flex items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[13px]"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
                {t(`botSettings.desktops.unavailable.${view.availability}`)}
              </p>
            )}

            <SettingsCard className="flex flex-col gap-4 p-[18px]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-foreground/5 text-foreground/75"
                  >
                    <Laptop className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {access
                        ? t('botSettings.desktops.on', {
                            name: view.links?.find((link) => link.self)?.name ?? access.macName,
                          })
                        : t('botSettings.desktops.enable')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {access ? t('botSettings.desktops.approvals') : t('botSettings.desktops.enableHint')}
                    </p>
                  </div>
                </div>
                <div data-testid="fleet-desktop-access-switch">
                  <SettingsSwitch
                    checked={!!access || editing}
                    disabled={busy || (!access && view.availability !== 'ready')}
                    label={access ? t('botSettings.desktops.turnOff') : t('botSettings.desktops.enable')}
                    onChange={() => {
                      if (access) setConfirming({ kind: 'disable' })
                      else if (editing) setDraft(null)
                      else
                        setDraft({
                          macName: view.defaultName.slice(0, FLEET_DESKTOP_BRIDGE_LIMITS.nameMax),
                          // Access is never pre-granted: every project and model is chosen by the person.
                          workspaceIds: [],
                          selections: [],
                          actions: [...BOT_ACTION_NAMES],
                          permissionCeiling: SUGGESTED_BOT_PERMISSION_CEILING,
                        })
                    }}
                  />
                </div>
              </div>

              {form && (view.availability === 'ready' || access) && (
                <form
                  className="flex flex-col gap-4 border-t border-border pt-4"
                  data-testid="fleet-desktop-access-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!draft || blockers.length) return
                    void perform(
                      () => window.api.fleetDesktopAccessSave(bot.id, { ...draft, macName: draft.macName.trim() }),
                      () => {
                        setDraft(null)
                        setSaved(true)
                      }
                    )
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-mac-name`} className="text-[13px] font-medium">
                      {t('botSettings.desktops.macName')}
                    </label>
                    <input
                      id={`${id}-mac-name`}
                      className={fieldInput}
                      value={form.macName}
                      maxLength={FLEET_DESKTOP_BRIDGE_LIMITS.nameMax}
                      autoComplete="off"
                      aria-invalid={!form.macName.trim()}
                      aria-describedby={`${id}-mac-name-hint`}
                      onChange={(event) => edit({ macName: event.target.value })}
                    />
                    <p id={`${id}-mac-name-hint`} className="text-xs text-muted-foreground">
                      {t('botSettings.desktops.macNameHint')}
                    </p>
                  </div>
                  <BotGrantFields
                    scope={`fleet-${bot.id}`}
                    testId="fleet-desktop"
                    workspaces={workspaces}
                    providers={providers}
                    value={form}
                    onChange={edit}
                  />
                  {editing && blockers.length > 0 && (
                    <div
                      data-testid="fleet-desktop-access-blockers"
                      className="rounded-md border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs text-amber-200"
                    >
                      <p>{t('ui:bots.blockersTitle')}</p>
                      <ul className="mt-1.5 list-disc space-y-1 pl-4">
                        {blockers.map((blocker) => (
                          <li key={blocker}>{blocker}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(editing || saved) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {editing && (
                        <>
                          <Button
                            type="submit"
                            size="sm"
                            data-testid="fleet-desktop-access-save"
                            disabled={busy || !dirty || blockers.length > 0 || view.availability !== 'ready'}
                          >
                            {busy
                              ? t('botSettings.desktops.saving')
                              : access
                                ? t('botSettings.desktops.save')
                                : t('botSettings.desktops.give')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setDraft(null)}
                          >
                            {access ? t('botSettings.desktops.discard') : t('botSettings.desktops.cancel')}
                          </Button>
                        </>
                      )}
                      {saved && !editing && (
                        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <CircleCheck className="size-3.5 text-status-ready" aria-hidden="true" />
                          {t('botSettings.desktops.saved')}
                        </p>
                      )}
                    </div>
                  )}
                </form>
              )}
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </SettingsCard>

            <section
              aria-labelledby={`${id}-others`}
              className="flex flex-col gap-2"
              data-testid="fleet-desktop-others"
            >
              <div>
                <h3 id={`${id}-others`} className="text-sm font-semibold">
                  {t('botSettings.desktops.others.title')}
                </h3>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t('botSettings.desktops.others.note')}</p>
              </div>
              {view.links === null ? (
                <p className="text-xs text-muted-foreground">
                  {view.availability === 'ready' ? t('botSettings.desktops.others.unknown') : '—'}
                </p>
              ) : others.length ? (
                <SettingsCard className="divide-y divide-border">
                  {others.map((link) => (
                    <div
                      key={link.desktopId}
                      data-testid="fleet-desktop-other"
                      data-desktop-id={link.desktopId}
                      className="flex flex-wrap items-center gap-3 px-[18px] py-3"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {link.name}
                          <span className="inline-flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-1.5 rounded-full',
                                link.online ? 'bg-status-ready' : 'bg-muted-foreground/70'
                              )}
                            />
                            {link.online
                              ? t('botSettings.desktops.others.online')
                              : t('botSettings.desktops.others.offline')}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t('botSettings.desktops.others.linkedAt', { date: date(link.linkedAt) })}
                          {!link.online && link.lastSeenAt
                            ? ` · ${t('botSettings.desktops.others.lastSeen', { date: date(link.lastSeenAt) })}`
                            : ''}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || view.availability !== 'ready'}
                        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setConfirming({ kind: 'remove', link })}
                      >
                        {t('botSettings.desktops.others.remove')}
                      </Button>
                    </div>
                  ))}
                </SettingsCard>
              ) : (
                <p className="text-xs text-muted-foreground">{t('botSettings.desktops.others.empty')}</p>
              )}
            </section>
          </>
        )}
      </div>
      {confirming?.kind === 'disable' && (
        <ConfirmDialog
          title={t('botSettings.desktops.disableTitle')}
          message={t('botSettings.desktops.disableMessage')}
          confirmLabel={t('botSettings.desktops.disableConfirm')}
          destructive
          busy={busy}
          error={error || null}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            void perform(
              () => window.api.fleetDesktopAccessDisable(bot.id),
              () => {
                setDraft(null)
                setConfirming(null)
              }
            )
          }
        />
      )}
      {confirming?.kind === 'remove' && (
        <ConfirmDialog
          title={t('botSettings.desktops.others.removeTitle', { name: confirming.link.name })}
          message={t('botSettings.desktops.others.removeMessage', { name: confirming.link.name })}
          confirmLabel={t('botSettings.desktops.others.removeConfirm')}
          destructive
          busy={busy}
          error={error || null}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            void perform(
              () => window.api.fleetDesktopAccessRemoveOther(bot.id, confirming.link.desktopId),
              () => setConfirming(null)
            )
          }
        />
      )}
    </SettingsSection>
  )
}
