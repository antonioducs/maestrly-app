import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isUpdatableRuntimeAssetId,
  type RuntimeAssetId,
  type RuntimeAssetInfo,
  type UpdatableRuntimeAssetId,
} from '../../../shared/runtime-assets'
import {
  assetProgress,
  formatBytes,
  formatCheckedAt,
  isRuntimeAssetUpdateActive,
  updateProgress,
} from './runtime-asset-presentation'

type ComponentAction = 'install' | 'repair' | 'remove'
type UpdateAction = 'check' | 'update' | 'rollback' | 'automatic'

const buttonCls = 'rounded border border-border px-2 py-0.5 text-[11px] disabled:opacity-50'

/**
 * Independent release controls for an updatable runtime. They describe only the release channel: update errors
 * never mark the installed version as broken, and activation never restarts Maestrly or interrupts open work.
 */
function RuntimeAssetUpdatePanel({
  asset,
  id,
  onChanged,
}: {
  asset: RuntimeAssetInfo
  id: UpdatableRuntimeAssetId
  onChanged: (next: RuntimeAssetInfo) => void
}) {
  const { t, i18n } = useTranslation('chat')
  const [busy, setBusy] = useState<UpdateAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Optimistic value while the preference is persisted in the main process.
  const [automaticDraft, setAutomaticDraft] = useState<boolean | null>(null)
  const update = asset.update
  if (!update || asset.status.state !== 'ready') return null

  const active = isRuntimeAssetUpdateActive(update.state)
  const locked = active || busy !== null
  const act = async (action: UpdateAction, enabled?: boolean) => {
    if (
      action === 'rollback' &&
      !confirm(t('settings.componentUpdateRollbackConfirm', { version: update.rollbackVersion }))
    )
      return
    setBusy(action)
    setError(null)
    if (action === 'automatic') setAutomaticDraft(enabled === true)
    try {
      const next = await (action === 'check'
        ? window.api.runtimeAssetCheckUpdate(id)
        : action === 'update'
          ? window.api.runtimeAssetUpdate(id)
          : action === 'rollback'
            ? window.api.runtimeAssetRollback(id)
            : window.api.runtimeAssetSetAutoUpdate(id, enabled === true))
      onChanged(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
      setAutomaticDraft(null)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span className="text-foreground">
          {t('settings.componentUpdateInstalled', { version: asset.status.version })}
        </span>
        {update.availableVersion ? (
          <span className="text-indigo-300">
            {t('settings.componentUpdateAvailable', { version: update.availableVersion })}
          </span>
        ) : update.state === 'up-to-date' ? (
          <span className="text-muted-foreground">{t('settings.componentUpdateUpToDate')}</span>
        ) : null}
        <span className="text-muted-foreground">
          {update.lastCheckedAt
            ? t('settings.componentUpdateLastChecked', {
                time: formatCheckedAt(update.lastCheckedAt, i18n.resolvedLanguage || i18n.language),
              })
            : t('settings.componentUpdateNeverChecked')}
        </span>
      </div>

      {active && (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground">{t(`settings.componentUpdateState_${update.state}`)}</p>
            {update.state !== 'checking' && (
              <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                <div className="h-full bg-indigo-400" style={{ width: `${updateProgress(asset)}%` }} />
              </div>
            )}
          </div>
          {update.state !== 'rolling-back' && (
            <button
              className="text-[11px] text-muted-foreground hover:text-foreground"
              type="button"
              onClick={() => void window.api.runtimeAssetCancel(asset.id)}
            >
              {t('settings.componentCancel')}
            </button>
          )}
        </div>
      )}

      {!active && update.error && (
        <p className="text-[11px] text-amber-300">{t(`settings.componentUpdateError_${update.error}`)}</p>
      )}
      {update.rejectedVersion && (
        <p className="text-[11px] text-muted-foreground">{t('settings.componentUpdateSkipped')}</p>
      )}
      {update.restartRequired && <p className="text-[11px] text-amber-300">{t('settings.componentUpdateRestart')}</p>}
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-1.5">
        <button className={buttonCls} disabled={locked} type="button" onClick={() => void act('check')}>
          {t('settings.componentUpdateCheck')}
        </button>
        {update.availableVersion && (
          <button className={buttonCls} disabled={locked} type="button" onClick={() => void act('update')}>
            {t('settings.componentUpdateNow', { version: update.availableVersion })}
          </button>
        )}
        {update.rollbackVersion && (
          <button className={buttonCls} disabled={locked} type="button" onClick={() => void act('rollback')}>
            {t('settings.componentUpdateRollback', { version: update.rollbackVersion })}
          </button>
        )}
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={automaticDraft ?? update.automatic}
          disabled={busy === 'automatic'}
          onChange={(event) => void act('automatic', event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-[11px] text-foreground">{t('settings.componentUpdateAutomatic')}</span>
          <span className="block text-[11px] text-muted-foreground">{t('settings.componentUpdateAutomaticHint')}</span>
        </span>
      </label>
    </div>
  )
}

export function RuntimeComponentsSettings() {
  const { t } = useTranslation('chat')
  const [assets, setAssets] = useState<readonly RuntimeAssetInfo[]>([])
  const [busy, setBusy] = useState<RuntimeAssetId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const replace = (next: RuntimeAssetInfo) =>
    setAssets((current) => current.map((item) => (item.id === next.id ? next : item)))
  const refresh = () => window.api.runtimeAssetList().then(setAssets)
  useEffect(() => {
    void refresh()
    return window.api.onRuntimeAssetChanged((next) =>
      setAssets((current) => current.map((item) => (item.id === next.id ? next : item)))
    )
  }, [])
  const act = async (id: RuntimeAssetId, action: ComponentAction) => {
    if (action === 'remove' && !confirm(t('settings.componentRemoveConfirm'))) return
    setBusy(id)
    setError(null)
    try {
      const next = await (action === 'install'
        ? window.api.runtimeAssetInstall(id)
        : action === 'repair'
          ? window.api.runtimeAssetRepair(id)
          : window.api.runtimeAssetRemove(id))
      replace(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }
  const total = assets.reduce((sum, item) => sum + item.status.diskUsageBytes, 0)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="text-[12px] text-muted-foreground">{t('settings.componentsDescription')}</p>
        <span className="text-[11px] text-foreground">
          {t('settings.componentsTotal', { size: formatBytes(total) })}
        </span>
      </div>
      {assets.map((asset) => {
        const active = ['downloading', 'verifying', 'installing', 'removing'].includes(asset.status.state)
        const updating = asset.update ? isRuntimeAssetUpdateActive(asset.update.state) : false
        return (
          <div key={asset.id} className="rounded-md border border-border px-2.5 py-2" data-runtime-asset={asset.id}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-foreground">{t(`settings.componentName_${asset.id}`)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t(`settings.componentRequiredBy_${asset.id}`)} · {t(`settings.componentState_${asset.status.state}`)}{' '}
                  · v{asset.status.version ?? asset.availableVersion} ·{' '}
                  {t('settings.componentSizes', {
                    download: formatBytes(asset.downloadBytes),
                    installed: formatBytes(asset.status.diskUsageBytes || asset.unpackedBytes),
                  })}
                </p>
                {active && asset.status.state !== 'removing' && (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                    <div className="h-full bg-indigo-400" style={{ width: `${assetProgress(asset)}%` }} />
                  </div>
                )}
                {asset.status.error && <p className="mt-0.5 text-[11px] text-destructive">{asset.status.error}</p>}
              </div>
              {active ? (
                <button
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                  type="button"
                  onClick={() => void window.api.runtimeAssetCancel(asset.id)}
                >
                  {t('settings.componentCancel')}
                </button>
              ) : asset.status.state === 'ready' ? (
                <button
                  className={buttonCls}
                  disabled={busy === asset.id || updating}
                  type="button"
                  onClick={() => void act(asset.id, 'remove')}
                >
                  {t('settings.componentRemove')}
                </button>
              ) : asset.status.state === 'corrupt' || asset.status.state === 'failed' ? (
                <button
                  className={buttonCls}
                  disabled={busy === asset.id}
                  type="button"
                  onClick={() => void act(asset.id, 'repair')}
                >
                  {asset.status.state === 'corrupt' ? t('settings.componentRepair') : t('settings.componentRetry')}
                </button>
              ) : (
                <button
                  className={buttonCls}
                  disabled={busy === asset.id || asset.downloadBytes === 0}
                  type="button"
                  onClick={() => void act(asset.id, 'install')}
                >
                  {t('settings.componentInstall')}
                </button>
              )}
            </div>
            {isUpdatableRuntimeAssetId(asset.id) && (
              <RuntimeAssetUpdatePanel asset={asset} id={asset.id} onChanged={replace} />
            )}
          </div>
        )
      })}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
