import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatGptWebStatusPayload } from '../../../preload'
import type { RuntimeAssetInfo } from '../../../shared/runtime-assets'
import { openChatGptWebAppSettings } from '../../lib/chatgpt-web'

const inputCls =
  'rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'
const btnCls =
  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] text-white disabled:opacity-50 bg-violet-600 hover:bg-violet-500'
const linkCls = 'inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200'

const PLATFORM_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys'
const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'
const DEVELOPER_MODE_URL = 'https://chatgpt.com/#settings/SecurityAndLogin'

export function ChatGptWebSettings({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation('chat')
  const [status, setStatus] = useState<ChatGptWebStatusPayload | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [appName, setAppName] = useState('')
  const [busy, setBusy] = useState<'key' | 'tunnel' | 'session' | 'probe' | 'reset' | null>(null)
  const [checks, setChecks] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [tunnelAsset, setTunnelAsset] = useState<RuntimeAssetInfo | null>(null)

  useEffect(() => {
    void window.api.chatGptWebStatus().then((next) => {
      setStatus(next)
      setAppName(next.appName)
    })
    void window.api.chatGptWebChecks().then((result) => setChecks(result.raw))
    void window.api.runtimeAssetStatus('tunnel-client').then(setTunnelAsset)
    const offAsset = window.api.onRuntimeAssetChanged((next) => {
      if (next.id === 'tunnel-client') setTunnelAsset(next)
    })
    const offStatus = window.api.onChatGptWebStatus((next) => {
      setStatus(next)
      setAppName(next.appName)
      onChanged()
    })
    return () => {
      offAsset()
      offStatus()
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!status) return null

  const toggle = async (enabled: boolean) => {
    setStatus(await window.api.chatGptWebConfigure({ enabled }))
    onChanged()
  }

  const resetEmbeddedBrowser = async () => {
    setBusy('reset')
    setError(null)
    try {
      await window.api.chatGptWebBrowserReset()
      setNote(t('settings.chatgptWebBrowserResetDone'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const saveKey = async () => {
    if (!apiKey.trim()) return
    setBusy('key')
    setError(null)
    setNote(null)
    try {
      const probe = await window.api.chatGptWebPrincipals(apiKey.trim())
      if (!probe.ok) throw new Error(probe.error)
      setStatus(await window.api.chatGptWebConfigure({ apiKey: apiKey.trim() }))
      setApiKey('')
      setNote(t('settings.chatgptWebKeySaved', { count: probe.workspaces.length }))
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const createTunnel = async () => {
    setBusy('tunnel')
    setError(null)
    setNote(null)
    try {
      const result = await window.api.chatGptWebCreateTunnel({
        name: 'Maestrly',
      })
      if (!result.ok) throw new Error(result.error || 'unknown')
      setStatus(await window.api.chatGptWebStatus())
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const installTunnel = async () => {
    setBusy('tunnel')
    setError(null)
    try {
      const next =
        tunnelAsset?.status.state === 'failed' || tunnelAsset?.status.state === 'corrupt'
          ? await window.api.runtimeAssetRepair('tunnel-client')
          : await window.api.runtimeAssetInstall('tunnel-client')
      setTunnelAsset(next)
      if (next.status.state !== 'ready') throw new Error(next.status.error || t('settings.componentInstallFailed'))
      setStatus(await window.api.chatGptWebStatus())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const toggleProbe = async () => {
    setBusy('probe')
    setError(null)
    setNote(null)
    try {
      if (status.probeActive) {
        await window.api.chatGptWebProbeStop()
      } else {
        const result = await window.api.chatGptWebProbeStart()
        if (!result.ok) throw new Error(result.error || 'unknown')
      }
      setStatus(await window.api.chatGptWebStatus())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const openAppSettingsForRefresh = async () => {
    setBusy('probe')
    setError(null)
    setNote(null)
    try {
      await openChatGptWebAppSettings(status, window.api, CHATGPT_PLUGINS_URL)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const endAllSessions = async () => {
    setBusy('session')
    for (const session of status.sessions) {
      await window.api.chatGptWebCompanionEnd(session.conversationId)
    }
    setStatus(await window.api.chatGptWebStatus())
    setBusy(null)
    onChanged()
  }

  const activeSessions = status.sessions.filter((session) => session.state !== 'ended')
  const transportLocked = activeSessions.length > 0 || status.probeActive

  return (
    <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.04] px-3 py-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-1 size-2.5 shrink-0 rounded-full',
            activeSessions.length > 0
              ? 'bg-emerald-400'
              : status.configured
                ? 'bg-violet-400'
                : 'bg-muted-foreground/50'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-foreground">{t('settings.chatgptWebHeading')}</span>
            <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] uppercase tracking-wide text-amber-300">
              {t('settings.chatgptWebExperimental')}
            </span>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={status.enabled} onChange={(e) => void toggle(e.target.checked)} />
              {t('settings.chatgptWebEnable')}
            </label>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.chatgptWebDescription')}</p>

          {status.enabled && (
            <div className="mt-3 flex flex-col gap-3">
              {tunnelAsset?.status.state !== 'ready' && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">{t('settings.chatgptWebBinaryMissing')}</span>
                    {tunnelAsset && ['downloading', 'verifying', 'installing'].includes(tunnelAsset.status.state) ? (
                      <button type="button" onClick={() => void window.api.runtimeAssetCancel('tunnel-client')}>
                        {t('settings.componentCancel')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rounded border border-current/40 px-2 py-0.5"
                        disabled={busy === 'tunnel' || tunnelAsset === null}
                        onClick={() => void installTunnel()}
                      >
                        {tunnelAsset?.status.state === 'failed' || tunnelAsset?.status.state === 'corrupt'
                          ? t('settings.componentRetry')
                          : t('settings.componentInstall')}
                      </button>
                    )}
                  </div>
                  {tunnelAsset && ['downloading', 'verifying', 'installing'].includes(tunnelAsset.status.state) && (
                    <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                      <div
                        className="h-full bg-amber-400"
                        style={{
                          width: `${Math.min(100, ((tunnelAsset.status.bytesDownloaded ?? 0) / (tunnelAsset.status.totalBytes || tunnelAsset.downloadBytes)) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-md border border-border/60 px-2.5 py-2">
                <p className="text-[11px] text-foreground/90">{t('settings.chatgptWebCompanionFlow')}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.chatgptWebCompanionFlowHint')}</p>
                <p className="mt-1.5 rounded bg-violet-500/[0.06] px-2 py-1.5 text-[11px] text-violet-100/80">
                  {t('settings.chatgptWebAccessPerConversation')}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={busy === 'reset' || transportLocked}
                    onClick={() => void resetEmbeddedBrowser()}
                    title={transportLocked ? t('settings.chatgptWebResetNeedsNoSessions') : undefined}
                  >
                    {busy === 'reset' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
                    {t('settings.chatgptWebResetBrowser')}
                  </button>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium text-foreground/90">{t('settings.chatgptWebStepKey')}</p>
                <p className="text-[11px] text-muted-foreground">{t('settings.chatgptWebStepKeyHint')}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <input
                    type="password"
                    className={cn(inputCls, 'min-w-[240px] flex-1')}
                    placeholder={status.apiKeyPresent ? '••••••••' : 'sk-…'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className={btnCls}
                    disabled={busy === 'key' || !apiKey.trim() || transportLocked}
                    onClick={saveKey}
                    title={transportLocked ? t('settings.chatgptWebConfigLocked') : undefined}
                  >
                    {busy === 'key' && <Loader2 className="h-3 w-3 animate-spin" />}
                    {t('settings.chatgptWebSaveKey')}
                  </button>
                  <button
                    type="button"
                    className={linkCls}
                    onClick={() => window.api.openExternalUrl(PLATFORM_KEYS_URL)}
                  >
                    <ExternalLink className="h-3 w-3" /> {t('settings.chatgptWebOpenPlatform')}
                  </button>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium text-foreground/90">{t('settings.chatgptWebStepTunnel')}</p>
                {status.tunnelId ? (
                  <p className="mt-0.5 font-mono text-[11px] text-foreground/80">{status.tunnelId}</p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">{t('settings.chatgptWebStepTunnelHint')}</p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className={btnCls}
                    disabled={
                      busy === 'tunnel' ||
                      !status.apiKeyPresent ||
                      transportLocked ||
                      tunnelAsset?.status.state !== 'ready'
                    }
                    onClick={createTunnel}
                    title={transportLocked ? t('settings.chatgptWebConfigLocked') : undefined}
                  >
                    {busy === 'tunnel' && <Loader2 className="h-3 w-3 animate-spin" />}
                    {status.tunnelId ? t('settings.chatgptWebRecreateTunnel') : t('settings.chatgptWebCreateTunnel')}
                  </button>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium text-foreground/90">{t('settings.chatgptWebStepApp')}</p>
                <div
                  className={cn(
                    'mt-1 rounded-md border px-2.5 py-2',
                    status.probeActive
                      ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                      : 'border-amber-500/30 bg-amber-500/[0.06]'
                  )}
                >
                  <p className="text-[11px] text-foreground/90">
                    {status.probeActive ? t('settings.chatgptWebProbeOn') : t('settings.chatgptWebProbeOff')}
                  </p>
                  <button
                    type="button"
                    className={cn(btnCls, 'mt-1.5')}
                    disabled={busy === 'probe' || !status.configured || tunnelAsset?.status.state !== 'ready'}
                    onClick={toggleProbe}
                  >
                    {busy === 'probe' && <Loader2 className="h-3 w-3 animate-spin" />}
                    {status.probeActive ? t('settings.chatgptWebProbeStop') : t('settings.chatgptWebProbeStart')}
                  </button>
                </div>
                <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                  <li>{t('settings.chatgptWebStepAppDevMode')}</li>
                  <li>
                    {t('settings.chatgptWebStepAppCreate', {
                      name: status.tunnelId ?? '—',
                    })}
                  </li>
                  <li>{t('settings.chatgptWebStepAppPermissions')}</li>
                  <li>{t('settings.chatgptWebStepAppRefresh')}</li>
                </ol>
                {status.configured && status.appRefreshRequired && (
                  <div
                    role="alert"
                    className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200"
                  >
                    <span className="min-w-0 flex-1">{t('settings.chatgptWebAppRefreshRequired')}</span>
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-current/40 px-2 py-0.5 hover:opacity-80 disabled:opacity-50"
                      disabled={busy === 'probe'}
                      onClick={() => void openAppSettingsForRefresh()}
                    >
                      {busy === 'probe' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ExternalLink className="h-3 w-3" />
                      )}{' '}
                      {t('settings.chatgptWebOpenAppSettings')}
                    </button>
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className={linkCls}
                    onClick={() => window.api.openExternalUrl(DEVELOPER_MODE_URL)}
                  >
                    <ExternalLink className="h-3 w-3" /> {t('settings.chatgptWebOpenDevMode')}
                  </button>
                  <button
                    type="button"
                    className={linkCls}
                    onClick={() => window.api.openExternalUrl(CHATGPT_PLUGINS_URL)}
                  >
                    <ExternalLink className="h-3 w-3" /> {t('settings.chatgptWebOpenPlugins')}
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <input
                    className={cn(inputCls, 'w-[220px]')}
                    placeholder="Maestrly Bridge"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    onBlur={() => {
                      if (appName.trim())
                        void window.api.chatGptWebConfigure({
                          appName: appName.trim(),
                        })
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">{t('settings.chatgptWebAppNameHint')}</span>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium text-foreground/90">{t('settings.chatgptWebStepChecks')}</p>
                <p className="text-[11px] text-muted-foreground">{t('settings.chatgptWebStepChecksHint')}</p>
                <textarea
                  className={cn(inputCls, 'mt-1.5 h-20 w-full font-mono text-[11px]')}
                  placeholder={t('settings.chatgptWebChecksPlaceholder')}
                  value={checks}
                  onChange={(e) => setChecks(e.target.value)}
                  onBlur={() => void window.api.chatGptWebSetChecks(checks)}
                />
              </div>

              <div className="rounded-md border border-border/60 px-2.5 py-2">
                <p className="text-[11px] text-foreground/90">
                  {activeSessions.length === 0
                    ? t('settings.chatgptWebNoSessions')
                    : t('settings.chatgptWebSessionsActive', {
                        count: activeSessions.length,
                      })}
                </p>
                {activeSessions.map((session) => (
                  <p key={session.conversationId} className="mt-0.5 text-[11px] text-muted-foreground">
                    {t(`settings.chatgptWebState_${session.state}`)} ·{' '}
                    {t('settings.chatgptWebSessionActivity', {
                      tools: session.toolCalls,
                      deliveries: session.deliveries,
                    })}
                    {session.error ? ` · ${session.error}` : ''}
                  </p>
                ))}
                {activeSessions.length > 0 && (
                  <button
                    type="button"
                    className="mt-1.5 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    disabled={busy === 'session'}
                    onClick={endAllSessions}
                  >
                    {t('settings.chatgptWebEndSession')}
                  </button>
                )}
              </div>

              {note && <p className="text-[11px] text-emerald-300">{note}</p>}
              {error && <p className="text-[11px] text-destructive">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
