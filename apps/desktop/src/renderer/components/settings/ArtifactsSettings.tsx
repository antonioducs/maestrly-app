import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ArtifactHostStatus, type ArtifactSettings, MAX_ARTIFACT_NAME_CHARS } from '../../../shared/artifacts'
import { EXPIRY_CHOICES } from '@/components/artifacts/sharing-view'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { SettingsSwitch } from '@/components/fleet/SettingsSwitch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingLimitField } from './fields'
import type { TFn } from './shared'

const MAX_PORT = 65535
const MAX_QUOTA_GB = 100
const MAX_ADDRESS_CHARS = 300
const NEVER = 'never'

/** `https://host[:port]` and nothing after it, as the main process stores it; null when it is something else. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value)
    const plain = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
    return plain && (url.protocol === 'https:' || url.protocol === 'http:') ? url.origin : null
  } catch {
    return null
  }
}

/** A text setting, saved when the field loses focus or Enter is pressed. */
function SettingTextField({
  label,
  hint,
  value,
  placeholder,
  maxLength,
  testId,
  wide,
  onCommit,
}: {
  label: string
  hint: string
  value: string
  placeholder?: string
  maxLength: number
  testId: string
  wide?: boolean
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.trim()
    if (next !== value) onCommit(next)
    else setDraft(value)
  }
  return (
    <div className={wide ? 'flex flex-col gap-1.5' : 'flex items-start justify-between gap-3'}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-[11px] leading-snug text-muted-foreground">{hint}</div>
      </div>
      <input
        type="text"
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={label}
        data-testid={testId}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
        className={`${wide ? 'w-full font-mono text-[12.5px]' : 'w-56'} shrink-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground outline-none focus:border-primary/40`}
      />
    </div>
  )
}

function statusText(t: TFn, status: ArtifactHostStatus): string {
  if (status.state === 'running') {
    const base = t('artifacts.hostRunning', { port: status.port })
    if (status.quotaBytes === undefined) return base
    const usage = t('settings.artifacts.usage', {
      used: formatBytes(status.storageBytes ?? 0),
      total: formatBytes(status.quotaBytes),
      count: status.artifactCount ?? 0,
    })
    return `${base} · ${usage}`
  }
  if (status.problem) return t(`artifacts.problem.${status.problem}`, { port: status.port })
  return status.state === 'starting' ? t('artifacts.hostStarting') : t('artifacts.hostStopped')
}

/** Settings → Artifacts: the host on this computer, its port and storage limit, and how artifacts are shared. */
export function ArtifactsSettings() {
  const { t } = useTranslation('ui')
  const [settings, setSettings] = useState<ArtifactSettings | null>(null)
  const [status, setStatus] = useState<ArtifactHostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.artifacts.getSettings().then(setSettings)
    void window.api.artifacts.status().then(setStatus)
    return window.api.artifacts.onStatus(setStatus)
  }, [])

  const save = async (next: ArtifactSettings) => {
    setError(null)
    try {
      setSettings(await window.api.artifacts.setSettings(next))
      setStatus(await window.api.artifacts.status())
    } catch (reason) {
      setError(
        t('settings.artifacts.saveFailed', { message: reason instanceof Error ? reason.message : String(reason) })
      )
    }
  }

  if (!settings) return null
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">{t('settings.artifacts.title')}</h2>
        <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.artifacts.desc')}</p>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{t('settings.artifacts.hostEnabled')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">
            {t('settings.artifacts.hostEnabledHint')}
          </div>
        </div>
        <SettingsSwitch
          checked={settings.hostEnabled}
          label={t('settings.artifacts.hostEnabled')}
          onChange={() => void save({ ...settings, hostEnabled: !settings.hostEnabled })}
        />
      </div>
      <SettingLimitField
        label={t('settings.artifacts.port')}
        hint={t('settings.artifacts.portHint')}
        value={settings.port}
        emptyNote=""
        placeholder="4010"
        min={1024}
        onCommit={(port) => {
          if (port === null) return
          if (port > MAX_PORT) return setError(t('settings.artifacts.invalidPort'))
          void save({ ...settings, port })
        }}
      />
      <SettingLimitField
        label={t('settings.artifacts.quota')}
        hint={t('settings.artifacts.quotaHint')}
        value={settings.quotaGb}
        emptyNote=""
        placeholder="2"
        min={1}
        onCommit={(quotaGb) => {
          if (quotaGb === null) return
          if (quotaGb > MAX_QUOTA_GB) return setError(t('settings.artifacts.invalidQuota'))
          void save({ ...settings, quotaGb })
        }}
      />
      <SettingTextField
        wide
        label={t('settings.artifacts.publicAddress')}
        hint={t('settings.artifacts.publicAddressHint')}
        value={settings.publicAddress}
        placeholder="https://my-mac.example.ts.net"
        maxLength={MAX_ADDRESS_CHARS}
        testId="artifacts-public-address"
        onCommit={(value) => {
          const publicAddress = value === '' ? '' : originOf(value)
          if (publicAddress === null) return setError(t('settings.artifacts.invalidAddress'))
          void save({ ...settings, publicAddress })
        }}
      />
      <SettingTextField
        label={t('settings.artifacts.ownerName')}
        hint={t('settings.artifacts.ownerNameHint')}
        value={settings.ownerName}
        maxLength={MAX_ARTIFACT_NAME_CHARS}
        testId="artifacts-owner-name"
        onCommit={(ownerName) => void save({ ...settings, ownerName })}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{t('settings.artifacts.linkExpiry')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{t('settings.artifacts.linkExpiryHint')}</div>
        </div>
        <Select
          value={settings.linkExpiryDays === null ? NEVER : String(settings.linkExpiryDays)}
          onValueChange={(value) => void save({ ...settings, linkExpiryDays: value === NEVER ? null : Number(value) })}
        >
          <SelectTrigger
            className="h-8 w-40 shrink-0 text-sm"
            aria-label={t('settings.artifacts.linkExpiry')}
            data-testid="artifacts-link-expiry"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {/* A value saved outside the usual choices stays selectable instead of silently changing. */}
            {settings.linkExpiryDays !== null &&
              !(EXPIRY_CHOICES as readonly (number | null)[]).includes(settings.linkExpiryDays) && (
                <SelectItem value={String(settings.linkExpiryDays)}>
                  {t('artifacts.share.expiryDays', { count: settings.linkExpiryDays })}
                </SelectItem>
              )}
            {EXPIRY_CHOICES.map((days) => (
              <SelectItem key={days ?? NEVER} value={days === null ? NEVER : String(days)}>
                {days === null ? t('artifacts.share.expiryNever') : t('artifacts.share.expiryDays', { count: days })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {status && (
        <div className="rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
          <div className="text-sm font-medium text-foreground">{t('settings.artifacts.status')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{statusText(t, status)}</div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
