import type { FleetArtifactHost, FleetArtifactSettingsPatch } from '@maestrly/bot-fleet-protocol'
import type { FleetConnectionView } from '../../../preload/api-fleet'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Link, Lock, RotateCw, Server } from 'lucide-react'
import { type ArtifactServerStatus, MAX_ARTIFACT_NAME_CHARS } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { EXPIRY_CHOICES } from '@/components/artifacts/sharing-view'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { ChoiceMark } from '@/components/fleet/ChoiceMark'
import { SettingsSwitch } from '@/components/fleet/SettingsSwitch'
import { LegacyArtifactsNotice } from '@/components/artifacts/LegacyArtifactsNotice'
import { QUOTA_WARNING_RATIO, serverUnavailableReason } from '@/components/artifacts/artifacts-view'
import { useLegacyArtifacts } from '@/components/artifacts/use-artifacts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { choiceClass } from '@/lib/fleet/choice'
import { cn } from '@/lib/utils'

const MAX_QUOTA_GB = 100
const MAX_ADDRESS_CHARS = 300
const NEVER = 'never'

export type BotServerSetupChoice = 'local' | 'remote' | 'manual'

/** `https://host[:port]` and nothing after it, as the server stores it; null when it is something else. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value)
    const plain = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
    return plain && (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : null
  } catch {
    return null
  }
}

type FieldKey = 'address' | 'name' | 'expiry' | 'quota'
type FieldState = { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; text: string }

function FieldTag({ state }: { state: FieldState | undefined }) {
  const { t } = useTranslation('ui')
  if (state?.kind === 'saving')
    return (
      <span className="text-[11px] font-normal text-muted-foreground" aria-live="polite">
        {t('settings.artifacts.saving')}
      </span>
    )
  if (state?.kind === 'saved')
    return (
      <span className="flex items-center gap-1 text-[11px] font-normal text-status-ready" aria-live="polite">
        <Check className="size-3" aria-hidden="true" /> {t('settings.artifacts.saved')}
      </span>
    )
  return null
}

/** A text or number field saved when it loses focus or Enter is pressed; Escape puts the saved value back. */
function DraftInput({
  id,
  value,
  invalid,
  describedBy,
  className,
  onCommit,
  ...rest
}: {
  id: string
  value: string
  invalid: boolean
  describedBy: string
  className: string
  onCommit: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim())
  }
  return (
    <input
      id={id}
      value={draft}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setDraft(value)
      }}
      className={cn(
        'rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-primary/40 aria-[invalid=true]:border-destructive/60',
        className
      )}
      {...rest}
    />
  )
}

/** No bot server yet: the installer's choices, with "Artifacts only" chosen for this way in. */
function ServerSetup({ onSetup }: { onSetup: (choice: BotServerSetupChoice) => void }) {
  const { t } = useTranslation('ui')
  return (
    <section
      aria-labelledby="artifacts-setup-title"
      data-testid="artifacts-server-setup"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface-elevated p-5"
    >
      <div className="flex flex-col gap-1.5">
        <span className="mb-1.5 grid size-8 place-items-center rounded-lg bg-white/[0.05] text-muted-foreground">
          <Server className="size-4" aria-hidden="true" />
        </span>
        <h3 id="artifacts-setup-title" className="text-[15px] font-semibold text-foreground">
          {t('settings.artifacts.setup.title')}
        </h3>
        <p className="max-w-[56ch] text-[12.5px] leading-relaxed text-muted-foreground">
          {t('settings.artifacts.setup.text')}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label={t('settings.artifacts.setup.where')}>
        {(['local', 'remote'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => onSetup(choice)}
            className={cn(
              'flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              choiceClass(false)
            )}
          >
            <ChoiceMark selected={false} />
            <span>
              <strong className="block text-sm text-foreground">{t(`settings.artifacts.setup.${choice}Title`)}</strong>
              <span className="mt-1 block text-xs leading-relaxed">{t(`settings.artifacts.setup.${choice}Note`)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="link" className="h-auto px-0" onClick={() => onSetup('manual')}>
          {t('settings.artifacts.setup.manual')}
        </Button>
        <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.artifacts.setup.hint')}</p>
      </div>
    </section>
  )
}

/**
 * Settings → Artifacts. Artifacts live only on the bot server: its hosting, the address other people use, how the
 * owner appears to them, and its storage. Artifacts earlier versions left on this computer can be moved or deleted.
 */
export function ArtifactsSettings({
  onOpenFleet,
  onSetupServer,
}: {
  /** Opens Settings → Bot server, to manage or update the server. */
  onOpenFleet: () => void
  /** Opens the bot server setup on the chosen screen, with "Artifacts only" preselected. */
  onSetupServer: (choice: BotServerSetupChoice) => void
}) {
  const { t } = useTranslation('ui')
  const [status, setStatus] = useState<ArtifactServerStatus | null>(null)
  const [host, setHost] = useState<FleetArtifactHost | null>(null)
  const [connection, setConnection] = useState<FleetConnectionView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [fields, setFields] = useState<Partial<Record<FieldKey, FieldState>>>({})
  const legacy = useLegacyArtifacts()
  const timers = useRef(new Map<FieldKey, ReturnType<typeof setTimeout>>())

  const refresh = useCallback(async () => {
    const [nextStatus, nextHost, nextConnection] = await Promise.allSettled([
      window.api.artifacts.serverStatus(),
      window.api.artifacts.serverHost(),
      window.api.fleetGetConnection(),
    ])
    setStatus(nextStatus.status === 'fulfilled' ? nextStatus.value : { state: 'unreachable' })
    setHost(nextHost.status === 'fulfilled' ? nextHost.value : null)
    if (nextConnection.status === 'fulfilled') setConnection(nextConnection.value)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const offChanged = window.api.artifacts.onChanged(() => void refresh())
    const offConnection = window.api.onFleetConnection((view) => {
      setConnection(view)
      void refresh()
    })
    const pending = timers.current
    return () => {
      offChanged()
      offConnection()
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [refresh])

  const setField = (key: FieldKey, state: FieldState | undefined) => {
    clearTimeout(timers.current.get(key))
    setFields((current) => ({ ...current, [key]: state }))
    if (state?.kind === 'saved')
      timers.current.set(
        key,
        setTimeout(
          () => setFields((current) => (current[key] === state ? { ...current, [key]: undefined } : current)),
          1800
        )
      )
  }

  /** Saves on the server; the field shows "Saving…", then "Saved", or what went wrong. */
  const save = async (key: FieldKey | null, patch: FleetArtifactSettingsPatch) => {
    if (key) setField(key, { kind: 'saving' })
    else setBusy(true)
    try {
      setHost(await window.api.artifacts.setServerHost(patch))
      setStatus(await window.api.artifacts.serverStatus())
      if (key) setField(key, { kind: 'saved' })
    } catch (reason) {
      const text = t('settings.artifacts.saveFailed', {
        message: reason instanceof Error ? reason.message : String(reason),
      })
      if (key) setField(key, { kind: 'error', text })
    } finally {
      setBusy(false)
    }
  }

  const retry = async () => {
    setRetrying(true)
    await refresh().finally(() => setRetrying(false))
  }

  const raiseLimit = () => {
    const input = document.getElementById('artifacts-quota') as HTMLInputElement | null
    input?.scrollIntoView({ block: 'center' })
    input?.focus()
    input?.select()
  }

  if (!loaded) return null
  const reason = serverUnavailableReason(status)
  const reachable = status?.state === 'ready' || status?.state === 'off'
  const ready = status?.state === 'ready' ? status : null
  const hostname = connection?.hostname ?? connection?.url ?? ''
  const settings = host?.settings
  const errorOf = (key: FieldKey) => {
    const state = fields[key]
    return state?.kind === 'error' ? state.text : null
  }
  const describedBy = (key: FieldKey) => `artifacts-${key}-hint${errorOf(key) ? ` artifacts-${key}-error` : ''}`
  const fieldError = (key: FieldKey) =>
    errorOf(key) && (
      <p id={`artifacts-${key}-error`} role="alert" className="text-[11px] text-destructive">
        {errorOf(key)}
      </p>
    )

  const statusLine = {
    ready: t('settings.artifacts.server.ready', { host: hostname, count: ready?.artifactCount ?? 0 }),
    off: t('settings.artifacts.server.off', { host: hostname }),
    unreachable: t('settings.artifacts.server.unreachable', { host: hostname }),
    unsupported: t('settings.artifacts.server.unsupported', { host: hostname }),
    problem: t('settings.artifacts.server.problem', { host: hostname }),
    absent: '',
  }[reason ?? 'ready']
  const dot = {
    ready: 'bg-status-ready shadow-[0_0_0_3px_rgba(91,214,160,0.14)]',
    off: 'bg-muted-foreground',
    unreachable: 'bg-destructive shadow-[0_0_0_3px_rgba(255,122,133,0.14)]',
    problem: 'bg-destructive shadow-[0_0_0_3px_rgba(255,122,133,0.14)]',
    unsupported: 'bg-artifact-warn shadow-[0_0_0_3px_rgba(242,180,92,0.14)]',
    absent: 'bg-muted-foreground',
  }[reason ?? 'ready']
  const expiry = settings?.linkExpiryDays ?? null
  const ratio = ready?.quotaBytes ? Math.min(1, ready.storageBytes / ready.quotaBytes) : 0

  return (
    <section className="flex flex-col gap-7" data-testid="artifacts-settings">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('settings.artifacts.title')}</h2>
        <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.artifacts.desc')}</p>
      </div>

      <LegacyArtifactsNotice items={legacy.items} server={status} move={legacy.move} onRaiseLimit={raiseLimit} />

      {reason === 'absent' ? (
        <ServerSetup onSetup={onSetupServer} />
      ) : (
        <article
          aria-labelledby="artifacts-server-title"
          data-testid="artifacts-server"
          data-state={reason ?? 'ready'}
          className="overflow-hidden rounded-xl border border-border bg-surface-elevated"
        >
          <div className="flex items-center gap-3 px-4 py-3.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-muted-foreground">
              <Server className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <strong id="artifacts-server-title" className="block text-sm font-medium text-foreground">
                {t('artifacts.server.title')}
              </strong>
              <p role="status" className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <span aria-hidden="true" className={cn('size-[7px] shrink-0 rounded-full', dot)} />
                <span className="truncate">{statusLine}</span>
              </p>
            </div>
            {reachable && settings && (
              <SettingsSwitch
                checked={settings.enabled}
                disabled={busy}
                label={t('artifacts.server.enabled')}
                onChange={() => void save(null, { enabled: !settings.enabled })}
              />
            )}
          </div>
          <div className="flex flex-col gap-3 px-4 pb-4">
            {reason === null && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('settings.artifacts.server.readyNote')}
              </p>
            )}
            {reason === 'off' && (
              <p className="text-xs leading-relaxed text-muted-foreground">{t('settings.artifacts.server.offNote')}</p>
            )}
            {(reason === 'unreachable' || reason === 'problem') && (
              <div
                role="alert"
                className="flex gap-2.5 rounded-[10px] border border-destructive/30 bg-destructive/[0.08] px-3 py-2.5 text-xs"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p>{t(`settings.artifacts.server.${reason}Note`)}</p>
                  <Button size="sm" variant="outline" className="mt-2" disabled={retrying} onClick={() => void retry()}>
                    <RotateCw className={cn('size-3.5', retrying && 'animate-spin')} />{' '}
                    {t('settings.artifacts.server.retry')}
                  </Button>
                </div>
              </div>
            )}
            {reason === 'unsupported' && (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('settings.artifacts.server.unsupportedNote')}
                </p>
                <div>
                  <Button size="sm" variant="outline" onClick={onOpenFleet}>
                    {t('settings.artifacts.server.update')}
                  </Button>
                </div>
              </>
            )}
          </div>
          {reachable && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[11px] text-muted-foreground hairline-t">
              <span>
                {t('settings.artifacts.server.viewer')}{' '}
                <code className="font-mono text-foreground">{connection?.url?.replace(/^https?:\/\//, '') ?? ''}</code>
              </span>
              <Button variant="link" className="h-auto px-0 text-[11px] text-muted-foreground" onClick={onOpenFleet}>
                {t('settings.artifacts.server.manage')}
              </Button>
            </div>
          )}
        </article>
      )}

      {reachable && settings && (
        <>
          <section className="flex flex-col gap-3" aria-labelledby="artifacts-access-title">
            <h3 id="artifacts-access-title" className="text-sm font-medium text-foreground">
              {t('settings.artifacts.access.title')}
            </h3>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="artifacts-address"
                className="flex items-center gap-2 text-sm font-medium text-foreground"
              >
                {t('settings.artifacts.access.address')} <FieldTag state={fields.address} />
              </label>
              <p id="artifacts-address-hint" className="text-[11px] leading-snug text-muted-foreground">
                {t('settings.artifacts.access.addressHint')}
              </p>
              <DraftInput
                id="artifacts-address"
                data-testid="artifacts-server-address"
                value={settings.publicAddress}
                maxLength={MAX_ADDRESS_CHARS}
                placeholder="https://my-server.example.ts.net"
                invalid={!!errorOf('address')}
                describedBy={describedBy('address')}
                className="w-full font-mono text-[12.5px]"
                onCommit={(value) => {
                  const publicAddress = value === '' ? '' : originOf(value)
                  if (publicAddress === null)
                    return setField('address', { kind: 'error', text: t('settings.artifacts.access.invalid') })
                  void save('address', { publicAddress })
                }}
              />
              {fieldError('address') ??
                (settings.publicAddress ? (
                  <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Link className="size-3 shrink-0" aria-hidden="true" />
                    {t('settings.artifacts.access.links')}
                    <span className="truncate font-mono text-foreground">{settings.publicAddress}/a/…</span>
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Lock className="size-3 shrink-0" aria-hidden="true" />
                    {t('settings.artifacts.access.none')}
                  </p>
                ))}
            </div>
          </section>

          <section className="flex flex-col gap-4" aria-labelledby="artifacts-sharing-title">
            <h3 id="artifacts-sharing-title" className="text-sm font-medium text-foreground">
              {t('settings.artifacts.sharing.title')}
            </h3>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor="artifacts-name"
                    className="flex items-center gap-2 text-sm font-medium text-foreground"
                  >
                    {t('settings.artifacts.sharing.ownerName')} <FieldTag state={fields.name} />
                  </label>
                  <p id="artifacts-name-hint" className="text-[11px] leading-snug text-muted-foreground">
                    {t('settings.artifacts.sharing.ownerNameHint')}
                  </p>
                </div>
                <DraftInput
                  id="artifacts-name"
                  data-testid="artifacts-server-owner"
                  value={settings.ownerName}
                  maxLength={MAX_ARTIFACT_NAME_CHARS}
                  invalid={!!errorOf('name')}
                  describedBy={describedBy('name')}
                  className="w-56 shrink-0 max-sm:w-full"
                  onCommit={(ownerName) => {
                    if (/\p{Cc}/u.test(ownerName))
                      return setField('name', { kind: 'error', text: t('settings.artifacts.sharing.invalidName') })
                    void save('name', { ownerName })
                  }}
                />
              </div>
              {fieldError('name')}
            </div>
            <div className="flex items-start justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {t('settings.artifacts.sharing.linkExpiry')} <FieldTag state={fields.expiry} />
                </span>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t('settings.artifacts.sharing.linkExpiryHint')}
                </p>
                {fieldError('expiry')}
              </div>
              <Select
                value={expiry === null ? NEVER : String(expiry)}
                onValueChange={(value) =>
                  void save('expiry', { linkExpiryDays: value === NEVER ? null : Number(value) })
                }
              >
                <SelectTrigger
                  className="h-8 w-40 shrink-0 text-sm max-sm:w-full"
                  aria-label={t('settings.artifacts.sharing.linkExpiry')}
                  data-testid="artifacts-link-expiry"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {/* A value saved outside the usual choices stays selectable instead of silently changing. */}
                  {[...new Set<number | null>([...EXPIRY_CHOICES, expiry])].map((days) => (
                    <SelectItem key={days ?? NEVER} value={days === null ? NEVER : String(days)}>
                      {days === null
                        ? t('artifacts.share.expiryNever')
                        : t('artifacts.share.expiryDays', { count: days })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="artifacts-storage-title">
            <h3 id="artifacts-storage-title" className="text-sm font-medium text-foreground">
              {t('settings.artifacts.storage.title')}
            </h3>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="artifacts-quota"
                  className="flex items-center gap-2 text-sm font-medium text-foreground"
                >
                  {t('settings.artifacts.storage.limit')} <FieldTag state={fields.quota} />
                </label>
                <p id="artifacts-quota-hint" className="text-[11px] leading-snug text-muted-foreground">
                  {ready
                    ? t('settings.artifacts.storage.usage', {
                        used: formatBytes(ready.storageBytes),
                        total: formatBytes(ready.quotaBytes),
                      })
                    : t('settings.artifacts.storage.usageOff')}{' '}
                  {t('settings.artifacts.storage.hint')}
                </p>
              </div>
              <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <DraftInput
                  id="artifacts-quota"
                  data-testid="artifacts-server-quota"
                  type="number"
                  min={1}
                  max={MAX_QUOTA_GB}
                  inputMode="numeric"
                  value={String(settings.quotaGb)}
                  invalid={!!errorOf('quota')}
                  describedBy={describedBy('quota')}
                  className="w-16 text-right"
                  onCommit={(value) => {
                    const quotaGb = Number(value)
                    if (!Number.isInteger(quotaGb) || quotaGb < 1 || quotaGb > MAX_QUOTA_GB)
                      return setField('quota', { kind: 'error', text: t('settings.artifacts.storage.invalid') })
                    void save('quota', { quotaGb })
                  }}
                />
                GB
              </span>
            </div>
            {ready && (
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
                <i
                  className={cn(
                    'block h-full rounded-full',
                    ratio >= QUOTA_WARNING_RATIO ? 'bg-artifact-warn' : 'bg-primary'
                  )}
                  style={{ width: `${Math.max(1.5, ratio * 100)}%` }}
                />
              </div>
            )}
            {fieldError('quota')}
          </section>
        </>
      )}
    </section>
  )
}
