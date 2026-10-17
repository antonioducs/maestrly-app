import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleCheck, Laptop, Server } from 'lucide-react'
import { FLEET_DESKTOP_BRIDGE_LIMITS } from '@maestrly/bot-fleet-protocol'
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
import { SettingsCard } from './SettingsSection'
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

/** Where the access is given: this computer, or a workspaces environment of the server. */
export type BotAccessPlace = 'computer' | 'environment'

/** What one computer or environment gives one bot, as the card reads it and changes it. */
export interface BotAccessCardProps {
  /** A prefix for the ids of the card's fields, unique on the page. */
  id: string
  place: BotAccessPlace
  view: FleetDesktopAccessView
  /** The name the bot sees this place by unless the owner chooses another. */
  defaultName: string
  workspaces: BotWorkspaceOption[]
  providers: BotProviderOption[]
  save(input: FleetDesktopAccessInput): Promise<FleetDesktopAccessView>
  disable(): Promise<FleetDesktopAccessView>
  /** A newer view of the access, after a change made here. */
  onView(view: FleetDesktopAccessView): void
}

/**
 * The access one computer or environment gives one fleet bot: a switch that opens the form the owner chooses projects,
 * models, actions and a ceiling in, under the name the bot sees, saved with the card's own button. Nothing is granted
 * before the owner chooses it.
 */
export function BotAccessCard({
  id,
  place,
  view,
  defaultName,
  workspaces,
  providers,
  save,
  disable,
  onView,
}: BotAccessCardProps) {
  const { t } = useTranslation('fleet')
  // Texts that name the place; the actions read the same for both.
  const text = (key: string, values?: Record<string, string>) =>
    t(`botSettings.${place === 'computer' ? 'desktops' : 'environments'}.${key}`, values)
  const testId = place === 'computer' ? 'fleet-desktop-access' : 'fleet-environment-access'
  /** The form while the person gives access or changes it; null when nothing is being edited. */
  const [draft, setDraft] = useState<FleetDesktopAccessInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)

  async function perform(action: () => Promise<FleetDesktopAccessView>, after?: () => void) {
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      onView(await action())
      after?.()
      return true
    } catch (cause) {
      setError(fleetErrorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const access = view.access
  const form: FleetDesktopAccessInput | null = draft ?? access
  const editing = draft !== null
  const dirty = !!draft && (!access || !same(draft, access))
  const blockers = form
    ? [
        ...(!form.macName.trim() ? [text('nameRequired')] : []),
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
  const edit = (patch: Partial<FleetDesktopAccessInput>) => {
    if (!form) return
    setDraft({ ...form, ...patch })
    setSaved(false)
  }
  const Icon = place === 'computer' ? Laptop : Server

  return (
    <>
      {view.availability !== 'ready' && (
        <p
          role="status"
          data-testid={`${testId}-unavailable`}
          className="flex items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[13px]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          {text(`unavailable.${view.availability}`)}
        </p>
      )}

      <SettingsCard className="flex flex-col gap-4 p-[18px]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-foreground/5 text-foreground/75"
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {access
                  ? text('on', { name: view.links?.find((link) => link.self)?.name ?? access.macName })
                  : text('enable')}
              </p>
              <p className="text-xs text-muted-foreground">{access ? text('approvals') : text('enableHint')}</p>
            </div>
          </div>
          <div data-testid={`${testId}-switch`}>
            <SettingsSwitch
              checked={!!access || editing}
              disabled={busy || (!access && view.availability !== 'ready')}
              label={access ? text('turnOff') : text('enable')}
              onChange={() => {
                if (access) setConfirming(true)
                else if (editing) setDraft(null)
                else
                  setDraft({
                    macName: defaultName.slice(0, FLEET_DESKTOP_BRIDGE_LIMITS.nameMax),
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
            data-testid={`${testId}-form`}
            onSubmit={(event) => {
              event.preventDefault()
              if (!draft || blockers.length) return
              void perform(
                () => save({ ...draft, macName: draft.macName.trim() }),
                () => {
                  setDraft(null)
                  setSaved(true)
                }
              )
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-mac-name`} className="text-[13px] font-medium">
                {text('macName')}
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
                {text('macNameHint')}
              </p>
            </div>
            <BotGrantFields
              scope={id}
              testId={place === 'computer' ? 'fleet-desktop' : 'fleet-environment'}
              place={place}
              workspaces={workspaces}
              providers={providers}
              value={form}
              onChange={edit}
            />
            {editing && blockers.length > 0 && (
              <div
                data-testid={`${testId}-blockers`}
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
                      data-testid={`${testId}-save`}
                      disabled={busy || !dirty || blockers.length > 0 || view.availability !== 'ready'}
                    >
                      {busy
                        ? t('botSettings.desktops.saving')
                        : access
                          ? t('botSettings.desktops.save')
                          : t('botSettings.desktops.give')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
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
      {confirming && (
        <ConfirmDialog
          title={text('disableTitle')}
          message={text('disableMessage')}
          confirmLabel={t('botSettings.desktops.disableConfirm')}
          destructive
          busy={busy}
          error={error || null}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            void perform(disable, () => {
              setDraft(null)
              setConfirming(false)
            })
          }
        />
      )}
    </>
  )
}
