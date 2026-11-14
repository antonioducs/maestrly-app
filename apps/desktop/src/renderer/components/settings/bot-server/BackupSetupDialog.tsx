import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  FLEET_BACKUP_LIMITS,
  type FleetBackupProbeResponse,
  type FleetBackupRetention,
  type FleetBackupSelection,
  type FleetBackupStatus,
} from '@maestrly/bot-fleet-protocol'
import type {
  FleetBackupApi,
  FleetBackupDestinationDraft,
  FleetBackupDriveGrant,
} from '../../../../shared/fleet-backup'
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
import {
  type BackupSchedulePreset,
  backupErrorText,
  presetFromSchedule,
  s3MinimumPolicy,
  scheduleFromPreset,
} from '@/lib/fleet/backup'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { cn } from '@/lib/utils'
import { BackupScheduleFields } from './BackupScheduleFields'
import { RecoveryKeyStep } from './RecoveryKeyStep'

type Provider = FleetBackupDestinationDraft['provider']
type Fields = {
  drive: { folder: string; grant: FleetBackupDriveGrant | null }
  s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string }
  gcs: { bucket: string; prefix: string; serviceAccountJson: string }
}
const INITIAL: Fields = {
  drive: { folder: 'Maestrly backups', grant: null },
  s3: {
    endpoint: '',
    region: 'us-east-1',
    bucket: '',
    prefix: 'maestrly-backups',
    accessKeyId: '',
    secretAccessKey: '',
  },
  gcs: { bucket: '', prefix: 'maestrly-backups', serviceAccountJson: '' },
}
/** The destination the fields make, once every one it needs is filled in. */
function draftOf(provider: Provider, fields: Fields): FleetBackupDestinationDraft | null {
  if (provider === 'drive') {
    const { folder, grant } = fields.drive
    return grant && folder.trim() ? { provider, folder: folder.trim(), grantId: grant.grantId } : null
  }
  if (provider === 's3') {
    const s3 = fields.s3
    if (![s3.region, s3.bucket, s3.prefix, s3.accessKeyId, s3.secretAccessKey].every((value) => value.trim()))
      return null
    return {
      provider,
      endpoint: s3.endpoint.trim() || null,
      region: s3.region.trim(),
      bucket: s3.bucket.trim(),
      prefix: s3.prefix.trim().replace(/^\/+|\/+$/g, ''),
      accessKeyId: s3.accessKeyId.trim(),
      secretAccessKey: s3.secretAccessKey.trim(),
    }
  }
  const gcs = fields.gcs
  if (![gcs.bucket, gcs.prefix, gcs.serviceAccountJson].every((value) => value.trim())) return null
  return {
    provider,
    bucket: gcs.bucket.trim(),
    prefix: gcs.prefix.trim().replace(/^\/+|\/+$/g, ''),
    serviceAccountJson: gcs.serviceAccountJson.trim(),
  }
}
const DRIVE_UNAVAILABLE = 'not available in this build'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
}

/**
 * Where the backups are kept, and the check that reaches it: steps 1 and 2 of setting up backups, and the first step
 * of restoring on a server that has none.
 */
export function BackupDestinationStep({
  api,
  onProbed,
  creating = false,
}: {
  api: Pick<FleetBackupApi, 'probe' | 'driveSignIn' | 'cancelDriveSignIn'>
  onProbed: (draft: FleetBackupDestinationDraft, result: FleetBackupProbeResponse) => void
  /** The probe passed and the backup is being created at the destination, which can take a while. */
  creating?: boolean
}) {
  const { t } = useTranslation('fleet')
  const [provider, setProvider] = useState<Provider>('drive')
  const [fields, setFields] = useState<Fields>(INITIAL)
  const [signingIn, setSigningIn] = useState(false)
  const [driveUnavailable, setDriveUnavailable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<FleetBackupProbeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [policyCopied, setPolicyCopied] = useState(false)
  const draft = draftOf(provider, fields)
  const set = <P extends Provider>(which: P, patch: Partial<Fields[P]>) => {
    setResult(null)
    setFields((current) => ({ ...current, [which]: { ...current[which], ...patch } }))
  }
  const input = <P extends 's3' | 'gcs'>(which: P, name: keyof Fields[P] & string, type = 'text') => (
    <Input
      className="bg-surface-elevated"
      type={type}
      autoComplete="off"
      spellCheck={false}
      value={String(fields[which][name])}
      onChange={(event) => set(which, { [name]: event.target.value } as Partial<Fields[P]>)}
    />
  )
  const signIn = async () => {
    setError(null)
    setSigningIn(true)
    try {
      set('drive', { grant: await api.driveSignIn() })
    } catch (cause) {
      const message = fleetErrorMessage(cause)
      if (message.includes(DRIVE_UNAVAILABLE)) setDriveUnavailable(true)
      else if (!/cancelled/.test(message)) setError(message)
    } finally {
      setSigningIn(false)
    }
  }
  const check = async () => {
    if (!draft) return
    setError(null)
    setChecking(true)
    try {
      const probed = await api.probe(draft)
      setResult(probed)
      if (probed.state !== 'error') onProbed(draft, probed)
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setChecking(false)
    }
  }
  const choice = (value: Provider, title: string, hint: string, badge?: string) => (
    <button
      type="button"
      aria-pressed={provider === value}
      className={cn(
        'w-full rounded-lg border p-3 text-left',
        provider === value ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
      )}
      onClick={() => {
        setProvider(value)
        setResult(null)
        setError(null)
      }}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {title}
        {badge && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal">{badge}</span>}
      </span>
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </button>
  )
  const errorText = result?.state === 'error' ? backupErrorText(result.error) : null
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('botServer.backups.where')}</p>
      <div className="grid gap-2">
        {choice(
          'drive',
          t('botServer.backups.providers.drive'),
          t('botServer.backups.providers.driveHint'),
          t('botServer.backups.providers.recommended')
        )}
        {choice('s3', t('botServer.backups.providers.s3'), t('botServer.backups.providers.s3Hint'))}
        {choice('gcs', t('botServer.backups.providers.gcs'), t('botServer.backups.providers.gcsHint'))}
      </div>
      {provider === 'drive' &&
        (driveUnavailable ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t('botServer.backups.drive.unavailable')}
          </p>
        ) : (
          <div className="space-y-2">
            {fields.drive.grant ? (
              <p className="text-xs text-muted-foreground">
                {fields.drive.grant.account
                  ? t('botServer.backups.drive.connected', { account: fields.drive.grant.account })
                  : t('botServer.backups.drive.connectedNoAccount')}
              </p>
            ) : signingIn ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span role="status">{t('botServer.backups.drive.signingIn')}</span>
                <Button size="sm" variant="ghost" onClick={() => void api.cancelDriveSignIn()}>
                  {t('botServer.backups.drive.cancel')}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void signIn()}>
                {t('botServer.backups.drive.signIn')}
              </Button>
            )}
            <Field label={t('botServer.backups.fields.folder')}>
              <Input
                className="bg-surface-elevated"
                value={fields.drive.folder}
                onChange={(event) => set('drive', { folder: event.target.value })}
              />
            </Field>
          </div>
        ))}
      {provider === 's3' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label={t('botServer.backups.fields.endpoint')}>{input('s3', 'endpoint', 'url')}</Field>
          </div>
          <Field label={t('botServer.backups.fields.region')}>{input('s3', 'region')}</Field>
          <Field label={t('botServer.backups.fields.bucket')}>{input('s3', 'bucket')}</Field>
          <Field label={t('botServer.backups.fields.folder')}>{input('s3', 'prefix')}</Field>
          <Field label={t('botServer.backups.fields.accessKeyId')}>{input('s3', 'accessKeyId')}</Field>
          <div className="sm:col-span-2">
            <Field label={t('botServer.backups.fields.secretAccessKey')}>
              {input('s3', 'secretAccessKey', 'password')}
            </Field>
          </div>
          <details className="text-xs sm:col-span-2">
            <summary className="cursor-pointer text-muted-foreground">{t('botServer.backups.fields.policy')}</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border p-2 font-mono text-[11px]">
              {s3MinimumPolicy(fields.s3.bucket || 'my-bucket', fields.s3.prefix || 'maestrly-backups')}
            </pre>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard
                  .writeText(s3MinimumPolicy(fields.s3.bucket || 'my-bucket', fields.s3.prefix || 'maestrly-backups'))
                  .then(() => setPolicyCopied(true))
              }
            >
              {policyCopied ? t('botServer.backups.fields.copied') : t('botServer.backups.fields.copyPolicy')}
            </Button>
          </details>
        </div>
      )}
      {provider === 'gcs' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('botServer.backups.fields.bucket')}>{input('gcs', 'bucket')}</Field>
          <Field label={t('botServer.backups.fields.folder')}>{input('gcs', 'prefix')}</Field>
          <div className="space-y-1 sm:col-span-2">
            <Field label={t('botServer.backups.fields.serviceAccount')}>
              <textarea
                className="h-24 w-full rounded-md border border-input bg-surface-elevated p-2 font-mono text-xs"
                spellCheck={false}
                value={fields.gcs.serviceAccountJson}
                onChange={(event) => set('gcs', { serviceAccountJson: event.target.value })}
              />
            </Field>
            <label className="inline-flex cursor-pointer items-center text-xs text-muted-foreground underline underline-offset-2">
              {t('botServer.backups.fields.chooseFile')}
              <input
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void file.text().then((text) => set('gcs', { serviceAccountJson: text }))
                }}
              />
            </label>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!draft || checking || creating} onClick={() => void check()}>
          {(checking || creating) && <Loader2 className="animate-spin" />}
          {checking ? t('botServer.backups.checking') : t('botServer.backups.check')}
        </Button>
        {creating ? (
          <span role="status" className="text-xs text-muted-foreground">
            {t('botServer.backups.creating')}
          </span>
        ) : (
          result?.state === 'empty' && (
            <span role="status" className="text-xs text-muted-foreground">
              {t('botServer.backups.probe.empty')}
            </span>
          )
        )}
        {result?.state === 'existing' && (
          <span role="status" className="text-xs text-muted-foreground">
            {t('botServer.backups.probe.existing')}
          </span>
        )}
      </div>
      {(errorText || error) && (
        <p role="alert" className="text-xs text-destructive">
          {errorText ? t(errorText.key, errorText.values) : error}
        </p>
      )}
    </div>
  )
}

/** Connects to a backup that is already there, with the key this computer kept or one the owner enters (step 3b). */
export function ExistingKeyStep({
  api,
  draft,
  hasSavedKey,
  onConnected,
}: {
  api: Pick<FleetBackupApi, 'connect'>
  draft: FleetBackupDestinationDraft
  hasSavedKey: boolean
  onConnected: (status: FleetBackupStatus) => void
}) {
  const { t } = useTranslation('fleet')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const connect = async (recoveryKey: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.connect({ mode: 'connect', destination: draft, recoveryKey })
      if (result.ok) onConnected(result.status)
      else {
        const text = backupErrorText(result.error)
        setError(t(text.key, text.values))
      }
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('botServer.backups.probe.existing')}</p>
      {hasSavedKey && (
        <Button size="sm" disabled={busy} onClick={() => void connect(null)}>
          {t('botServer.backups.key.useSaved')}
        </Button>
      )}
      <Field label={t('botServer.backups.key.enter')}>
        <Input
          className="bg-surface-elevated font-mono"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          onChange={(event) => setTyped(event.target.value)}
        />
      </Field>
      <Button size="sm" variant="outline" disabled={busy || !typed.trim()} onClick={() => void connect(typed)}>
        {t('botServer.backups.key.connect')}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

type Step =
  | { kind: 'where' }
  | { kind: 'new-key'; recoveryKey: string; savedOnThisComputer: boolean; status: FleetBackupStatus }
  | { kind: 'existing-key'; draft: FleetBackupDestinationDraft; hasSavedKey: boolean }
  | { kind: 'what'; status: FleetBackupStatus }

/**
 * Sets up a server's backups: where (and the check that reaches it), the recovery key, then what and when. `change`
 * opens at what and when, for backups already set up.
 */
export function BackupSetupDialog({
  api,
  status,
  environmentNames,
  change,
  onClose,
  onStatus,
}: {
  api: FleetBackupApi
  status: FleetBackupStatus
  environmentNames: Record<string, string>
  change?: boolean
  onClose: () => void
  onStatus: (status: FleetBackupStatus) => void
}) {
  const { t } = useTranslation('fleet')
  const [step, setStep] = useState<Step>(change ? { kind: 'what', status } : { kind: 'where' })
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const advance = (next: FleetBackupStatus) => {
    onStatus(next)
    setStep({ kind: 'what', status: next })
  }
  const probed = async (draft: FleetBackupDestinationDraft, result: FleetBackupProbeResponse) => {
    setError(null)
    if (result.state === 'existing') {
      setStep({ kind: 'existing-key', draft, hasSavedKey: await api.hasSavedKey(draft).catch(() => false) })
      return
    }
    setBusy(true)
    try {
      const created = await api.connect({ mode: 'create', destination: draft })
      if (!created.ok) {
        const text = backupErrorText(created.error)
        setError(t(text.key, text.values))
        return
      }
      onStatus(created.status)
      setStep({
        kind: 'new-key',
        recoveryKey: created.recoveryKey ?? (await api.recoveryKey()),
        savedOnThisComputer: created.savedOnThisComputer,
        status: created.status,
      })
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{change ? t('botServer.backups.changeTitle') : t('botServer.backups.setupTitle')}</DialogTitle>
          <DialogDescription>{t('botServer.backups.intro')}</DialogDescription>
        </DialogHeader>
        {step.kind === 'where' && (
          <BackupDestinationStep api={api} creating={busy} onProbed={(draft, result) => void probed(draft, result)} />
        )}
        {step.kind === 'existing-key' && (
          <ExistingKeyStep api={api} draft={step.draft} hasSavedKey={step.hasSavedKey} onConnected={advance} />
        )}
        {step.kind === 'new-key' && (
          <RecoveryKeyStep
            recoveryKey={step.recoveryKey}
            savedOnThisComputer={step.savedOnThisComputer}
            onSave={() => api.exportRecoveryKey()}
            confirmed={confirmed}
            onConfirm={setConfirmed}
          />
        )}
        {step.kind === 'what' && (
          <WhatAndWhen
            api={api}
            status={step.status}
            environmentNames={environmentNames}
            submitLabel={
              change && step.status.enabled
                ? t('botServer.backups.actions.save')
                : t('botServer.backups.actions.turnOn')
            }
            onSaved={(next) => {
              onStatus(next)
              onClose()
            }}
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {step.kind === 'new-key' && (
          <DialogFooter>
            <Button disabled={!confirmed} onClick={() => setStep({ kind: 'what', status: step.status })}>
              {t('botServer.backups.next')}
            </Button>
          </DialogFooter>
        )}
        {step.kind === 'existing-key' && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStep({ kind: 'where' })}>
              {t('botServer.backups.back')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

const INELIGIBLE: Record<string, string> = {
  'shared-folder': 'botServer.backups.what.sharedFolder',
  archived: 'botServer.backups.what.archived',
  'not-ready': 'botServer.backups.what.notReady',
}

/** Which environments, when, and how many backups to keep (step 4); saving turns backups on. */
function WhatAndWhen({
  api,
  status,
  environmentNames,
  submitLabel,
  onSaved,
}: {
  api: Pick<FleetBackupApi, 'update'>
  status: FleetBackupStatus
  environmentNames: Record<string, string>
  submitLabel: string
  onSaved: (status: FleetBackupStatus) => void
}) {
  const { t } = useTranslation('fleet')
  const [selection, setSelection] = useState<FleetBackupSelection>(status.selection)
  const [preset, setPreset] = useState<BackupSchedulePreset>(presetFromSchedule(status.schedule))
  const [retention, setRetention] = useState<FleetBackupRetention>(status.retention)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = new Set(selection.mode === 'selected' ? selection.environments : [])
  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen)
    if (on) next.add(id)
    else next.delete(id)
    setSelection({ mode: 'selected', environments: [...next] })
  }
  const keep = (which: keyof FleetBackupRetention, max: number) => (
    <label className="block space-y-1 text-xs">
      <span>{t(`botServer.backups.keep.${which}`)}</span>
      <Input
        type="number"
        min={0}
        max={max}
        className="h-8 w-24 bg-surface-elevated"
        value={retention[which]}
        onChange={(event) => {
          const value = Math.max(0, Math.min(max, Math.trunc(Number(event.target.value) || 0)))
          setRetention({ ...retention, [which]: value })
        }}
      />
    </label>
  )
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onSaved(
        await api.update({
          enabled: true,
          schedule: scheduleFromPreset(preset, Intl.DateTimeFormat().resolvedOptions().timeZone),
          selection,
          retention,
        })
      )
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('botServer.backups.what.title')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="backup-selection"
            checked={selection.mode === 'all'}
            onChange={() => setSelection({ mode: 'all' })}
          />
          {t('botServer.backups.what.all')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="backup-selection"
            checked={selection.mode === 'selected'}
            onChange={() =>
              setSelection({
                mode: 'selected',
                environments: status.environments
                  .filter((row) => !INELIGIBLE[row.eligibility])
                  .map((row) => row.environmentId),
              })
            }
          />
          {t('botServer.backups.what.selected')}
        </label>
        {selection.mode === 'selected' && (
          <ul className="space-y-1 pl-6">
            {status.environments.map((row) => {
              const reason = INELIGIBLE[row.eligibility]
              return (
                <li key={row.environmentId}>
                  <label className={cn('flex items-center gap-2 text-sm', reason && 'text-muted-foreground')}>
                    <input
                      type="checkbox"
                      disabled={!!reason}
                      checked={!reason && chosen.has(row.environmentId)}
                      onChange={(event) => toggle(row.environmentId, event.target.checked)}
                    />
                    {environmentNames[row.environmentId] ?? row.environmentId}
                    {reason && <span className="text-xs">· {t(reason)}</span>}
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>
      <BackupScheduleFields preset={preset} onChange={setPreset} disabled={busy} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t('botServer.backups.advanced')}</summary>
        <div className="mt-2 flex flex-wrap gap-3">
          {keep('daily', FLEET_BACKUP_LIMITS.keepDailyMax)}
          {keep('weekly', FLEET_BACKUP_LIMITS.keepWeeklyMax)}
          {keep('monthly', FLEET_BACKUP_LIMITS.keepMonthlyMax)}
        </div>
      </details>
      <p className="text-xs text-muted-foreground">{t('botServer.backups.retention', retention)}</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button
          disabled={busy || retention.daily + retention.weekly + retention.monthly === 0}
          onClick={() => void save()}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}
