import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactHostStatus, ArtifactSettings } from '../../../shared/artifacts'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { SettingsSwitch } from '@/components/fleet/SettingsSwitch'
import { SettingLimitField } from './fields'
import type { TFn } from './shared'

const MAX_PORT = 65535
const MAX_QUOTA_GB = 100

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

/** Settings → Artifacts: the host on this computer, its port and its storage limit. */
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
      {status && (
        <div className="rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
          <div className="text-sm font-medium text-foreground">{t('settings.artifacts.status')}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{statusText(t, status)}</div>
        </div>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">{t('settings.artifacts.localOnly')}</p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
