import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ExternalLink, Loader2, MoreHorizontal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import type { ChatGptWebStatusPayload } from '../../../preload'
import type { RuntimeAssetInfo } from '../../../shared/runtime-assets'
import { openChatGptWebAppSettings } from '../../lib/chatgpt-web'
import {
  CHATGPT_WEB_ENTRY_KEY,
  type ChatGptWebAccountSnapshot,
  type ChatGptWebPhase,
  chatGptWebPhase,
} from './accounts/account-entries'
import {
  DetailBackButton,
  DetailHeader,
  DetailSection,
  iconButtonCls,
  inputCls,
  linkButtonCls,
  primaryButtonCls,
  ProviderMark,
  secondaryButtonCls,
  Switch,
} from './accounts/account-ui'

const PLATFORM_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys'
const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'
const DEVELOPER_MODE_URL = 'https://chatgpt.com/#settings/SecurityAndLogin'

/** One-line state of the companion, shared by its list row and its detail header. */
export function useChatGptWebPhaseLabel() {
  const { t } = useTranslation('chat')
  return (phase: ChatGptWebPhase, activeSessions: number): string =>
    phase === 'loading'
      ? t('settings.loading')
      : phase === 'sessions'
        ? t('settings.chatgptWebPhase_sessions', { count: activeSessions })
        : t(`settings.chatgptWebPhase_${phase}`)
}

type StepState = 'done' | 'current' | 'manual' | 'todo'

function SetupStep({
  index,
  state,
  title,
  last = false,
  children,
}: {
  index: number
  state: StepState
  title: ReactNode
  last?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('chat')
  return (
    <li className="relative grid grid-cols-[22px_1fr] gap-3 pb-5 last:pb-0">
      {!last && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute bottom-1 left-[10px] top-7 w-0.5 rounded-full',
            state === 'done' ? 'bg-emerald-500/35' : 'bg-border'
          )}
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'grid size-[22px] place-items-center rounded-full border font-mono text-[10px] font-semibold',
          state === 'done' && 'border-emerald-500 bg-emerald-500 text-emerald-950',
          state === 'current' && 'border-indigo-400 text-indigo-300 ring-[3px] ring-indigo-400/20',
          state === 'manual' && 'border-muted-foreground text-foreground',
          state === 'todo' && 'border-border text-muted-foreground'
        )}
      >
        {state === 'done' ? '✓' : index}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            'flex min-h-[22px] flex-wrap items-center gap-x-2 text-[12px] font-medium',
            state === 'todo' ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {title}
          {state === 'done' && <span className="sr-only">({t('settings.chatgptWebStepDone')})</span>}
        </p>
        <div className="mt-1 text-[12px] text-muted-foreground">{children}</div>
      </div>
    </li>
  )
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

export function ChatGptWebSettings({
  selected,
  onSnapshot,
  onBack,
  onChanged,
}: {
  selected: boolean
  onSnapshot: (key: string, snapshot: ChatGptWebAccountSnapshot | null) => void
  onBack: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const phaseLabel = useChatGptWebPhaseLabel()
  const [status, setStatus] = useState<ChatGptWebStatusPayload | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [appName, setAppName] = useState('')
  const [appStepsOpen, setAppStepsOpen] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<'key' | 'tunnel' | 'session' | 'probe' | 'reset' | null>(null)
  const [checks, setChecks] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [tunnelAsset, setTunnelAsset] = useState<RuntimeAssetInfo | null>(null)

  useEffect(() => {
    void api.chatGptWebStatus().then((next) => {
      setStatus(next)
      setAppName(next.appName)
    })
    void api.chatGptWebChecks().then((result) => setChecks(result.raw))
    void api.runtimeAssetStatus('tunnel-client').then(setTunnelAsset)
    const offAsset = api.onRuntimeAssetChanged((next) => {
      if (next.id === 'tunnel-client') setTunnelAsset(next)
    })
    const offStatus = api.onChatGptWebStatus((next) => {
      setStatus(next)
      setAppName(next.appName)
      onChanged()
    })
    return () => {
      offAsset()
      offStatus()
    }
  }, [api])

  const tunnelReady = tunnelAsset ? tunnelAsset.status.state === 'ready' : null
  useEffect(() => {
    onSnapshot(CHATGPT_WEB_ENTRY_KEY, { status, tunnelReady })
  }, [onSnapshot, status, tunnelReady])
  useEffect(() => () => onSnapshot(CHATGPT_WEB_ENTRY_KEY, null), [onSnapshot])

  if (!selected || !status) return null

  const toggle = async (enabled: boolean) => {
    setStatus(await api.chatGptWebConfigure({ enabled }))
    onChanged()
  }

  const resetEmbeddedBrowser = async () => {
    setBusy('reset')
    setError(null)
    try {
      await api.chatGptWebBrowserReset()
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
      const probe = await api.chatGptWebPrincipals(apiKey.trim())
      if (!probe.ok) throw new Error(probe.error)
      setStatus(await api.chatGptWebConfigure({ apiKey: apiKey.trim() }))
      setApiKey('')
      setEditingKey(false)
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
      const result = await api.chatGptWebCreateTunnel({
        name: 'Maestrly',
      })
      if (!result.ok) throw new Error(result.error || 'unknown')
      setStatus(await api.chatGptWebStatus())
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
          ? await api.runtimeAssetRepair('tunnel-client')
          : await api.runtimeAssetInstall('tunnel-client')
      setTunnelAsset(next)
      if (next.status.state !== 'ready') throw new Error(next.status.error || t('settings.componentInstallFailed'))
      setStatus(await api.chatGptWebStatus())
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
        await api.chatGptWebProbeStop()
      } else {
        const result = await api.chatGptWebProbeStart()
        if (!result.ok) throw new Error(result.error || 'unknown')
      }
      setStatus(await api.chatGptWebStatus())
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
      await openChatGptWebAppSettings(
        status,
        { chatGptWebProbeStart: api.chatGptWebProbeStart, openExternalUrl: window.api.openExternalUrl },
        CHATGPT_PLUGINS_URL
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const endSessions = async (conversationIds: string[]) => {
    setBusy('session')
    for (const conversationId of conversationIds) {
      await api.chatGptWebCompanionEnd(conversationId)
    }
    setStatus(await api.chatGptWebStatus())
    setBusy(null)
    onChanged()
  }

  const activeSessions = status.sessions.filter((session) => session.state !== 'ended')
  const transportLocked = activeSessions.length > 0 || status.probeActive
  const phase = chatGptWebPhase({ status, tunnelReady })
  const phaseTone =
    phase === 'ready' || phase === 'sessions'
      ? 'text-emerald-400'
      : phase === 'error'
        ? 'text-rose-300'
        : phase === 'off'
          ? 'text-muted-foreground'
          : 'text-amber-300'
  const assetBusy = !!tunnelAsset && ['downloading', 'verifying', 'installing'].includes(tunnelAsset.status.state)
  const showKeyForm = !status.apiKeyPresent || editingKey
  const appStepsExpanded = appStepsOpen ?? (!status.configured || status.appRefreshRequired)

  const header = (
    <DetailHeader
      mark={<ProviderMark kind="chatgpt-web" size="lg" />}
      title={t('settings.chatgptWebHeading')}
      status={<span className={cn('text-[12px]', phaseTone)}>{phaseLabel(phase, activeSessions.length)}</span>}
      subtitle={t('settings.chatgptWebDescription')}
      actions={
        <>
          <span id="chatgpt-web-enabled" className="text-[11px] text-muted-foreground">
            {t('settings.chatgptWebEnable')}
          </span>
          <Switch checked={status.enabled} onChange={(next) => void toggle(next)} labelledBy="chatgpt-web-enabled" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={iconButtonCls}
                aria-label={t('settings.accountMoreActions')}
                title={t('settings.accountMoreActions')}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={busy === 'reset' || transportLocked}
                title={transportLocked ? t('settings.chatgptWebResetNeedsNoSessions') : undefined}
                onSelect={() => void resetEmbeddedBrowser()}
              >
                {t('settings.chatgptWebResetBrowser')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  )

  const messages = (
    <>
      {note && <p className="mt-3 text-[12px] text-emerald-300">{note}</p>}
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </>
  )

  if (!status.enabled) {
    return (
      <div data-chatgpt-web-settings="">
        <DetailBackButton onBack={onBack} />
        {header}
        <DetailSection>
          <p className="text-[12px] text-muted-foreground">{t('settings.chatgptWebOffHint')}</p>
          <button type="button" className={cn(primaryButtonCls, 'mt-3')} onClick={() => void toggle(true)}>
            {t('settings.chatgptWebTurnOn')}
          </button>
        </DetailSection>
        {messages}
      </div>
    )
  }

  return (
    <div data-chatgpt-web-settings="">
      <DetailBackButton onBack={onBack} />
      {header}

      {tunnelAsset?.status.state !== 'ready' && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] text-amber-200">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">{t('settings.chatgptWebBinaryMissing')}</span>
            {assetBusy ? (
              <button type="button" onClick={() => void api.runtimeAssetCancel('tunnel-client')}>
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
          {tunnelAsset && assetBusy && (
            <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
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
      {status.tunnelState === 'error' && status.tunnelError && (
        <p className="mt-3 text-[12px] text-destructive">{status.tunnelError}</p>
      )}

      {status.configured && (
        <DetailSection
          title={t('settings.chatgptWebSessionsHeading')}
          hint={activeSessions.length > 0 ? t('settings.chatgptWebSessionsShared') : undefined}
          action={
            activeSessions.length > 1 ? (
              <button
                type="button"
                className={secondaryButtonCls}
                disabled={busy === 'session'}
                onClick={() => void endSessions(activeSessions.map((session) => session.conversationId))}
              >
                {t('settings.chatgptWebEndAllSessions')}
              </button>
            ) : undefined
          }
        >
          {activeSessions.length === 0 ? (
            <>
              <p className="text-[12px] text-foreground/90">{t('settings.chatgptWebNoSessions')}</p>
              <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.chatgptWebCompanionFlowHint')}</p>
            </>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {activeSessions.map((session) => (
                <li
                  key={session.conversationId}
                  className="flex items-center gap-2.5 rounded-md border border-border/60 bg-white/[0.02] px-2.5 py-2"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      session.state === 'live'
                        ? 'bg-emerald-400 ring-[3px] ring-emerald-400/20'
                        : session.state === 'error'
                          ? 'bg-rose-400'
                          : 'bg-amber-400'
                    )}
                  />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-[12px] text-foreground" title={session.cwd}>
                      {basename(session.cwd)}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t(`settings.chatgptWebState_${session.state}`)} ·{' '}
                      {t('settings.chatgptWebSessionActivity', {
                        tools: session.toolCalls,
                        deliveries: session.deliveries,
                      })}
                      {session.error ? ` · ${session.error}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={secondaryButtonCls}
                    disabled={busy === 'session'}
                    onClick={() => void endSessions([session.conversationId])}
                  >
                    {t('settings.chatgptWebEndSession')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>
      )}

      <DetailSection title={t('settings.chatgptWebSetupHeading')}>
        <p className="mb-4 text-[12px] text-muted-foreground">{t('settings.chatgptWebAccessPerConversation')}</p>
        {transportLocked && (
          <p className="-mt-2 mb-4 text-[11px] text-amber-300">{t('settings.chatgptWebConfigLocked')}</p>
        )}
        <ol>
          <SetupStep
            index={1}
            state={showKeyForm ? 'current' : 'done'}
            title={
              <>
                {t('settings.chatgptWebStepKey')}
                <span className="font-normal text-muted-foreground">{t('settings.chatgptWebStepKeyTag')}</span>
              </>
            }
          >
            {showKeyForm ? (
              <>
                <p>{t('settings.chatgptWebStepKeyHint')}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <input
                    type="password"
                    className={cn(inputCls, 'min-w-[220px] flex-1 font-mono text-[12px]')}
                    placeholder={status.apiKeyPresent ? '••••••••' : 'sk-…'}
                    aria-label={t('settings.chatgptWebStepKey')}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveKey()
                    }}
                  />
                  <button
                    type="button"
                    className={primaryButtonCls}
                    disabled={busy === 'key' || !apiKey.trim() || transportLocked}
                    onClick={() => void saveKey()}
                    title={transportLocked ? t('settings.chatgptWebConfigLocked') : undefined}
                  >
                    {busy === 'key' && <Loader2 className="h-3 w-3 animate-spin" />}
                    {t('settings.chatgptWebSaveKey')}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className={linkButtonCls}
                    onClick={() => window.api.openExternalUrl(PLATFORM_KEYS_URL)}
                  >
                    <ExternalLink className="h-3 w-3" /> {t('settings.chatgptWebOpenPlatform')}
                  </button>
                  {status.apiKeyPresent && (
                    <button type="button" className={linkButtonCls} onClick={() => setEditingKey(false)}>
                      {t('settings.chatgptWebKeepKey')}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-emerald-300">{t('settings.chatgptWebKeyPresent')}</span>
                <button
                  type="button"
                  className={linkButtonCls}
                  disabled={transportLocked}
                  onClick={() => setEditingKey(true)}
                >
                  {t('settings.chatgptWebReplaceKey')}
                </button>
              </div>
            )}
          </SetupStep>

          <SetupStep
            index={2}
            state={status.tunnelId ? 'done' : status.apiKeyPresent ? 'current' : 'todo'}
            title={t('settings.chatgptWebStepTunnel')}
          >
            {status.tunnelId ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <code className="break-all rounded bg-white/[0.06] px-1 font-mono text-[11px] text-foreground/90">
                  {status.tunnelId}
                </code>
                <button
                  type="button"
                  className={linkButtonCls}
                  disabled={busy === 'tunnel' || transportLocked || tunnelAsset?.status.state !== 'ready'}
                  onClick={() => void createTunnel()}
                  title={transportLocked ? t('settings.chatgptWebConfigLocked') : undefined}
                >
                  {busy === 'tunnel' && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('settings.chatgptWebRecreateTunnel')}
                </button>
              </div>
            ) : (
              <>
                <p>{t('settings.chatgptWebStepTunnelHint')}</p>
                <button
                  type="button"
                  className={cn(primaryButtonCls, 'mt-2')}
                  disabled={
                    busy === 'tunnel' ||
                    !status.apiKeyPresent ||
                    transportLocked ||
                    tunnelAsset?.status.state !== 'ready'
                  }
                  onClick={() => void createTunnel()}
                >
                  {busy === 'tunnel' && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('settings.chatgptWebCreateTunnel')}
                </button>
              </>
            )}
          </SetupStep>

          <SetupStep
            index={3}
            state={status.tunnelId ? 'manual' : 'todo'}
            title={
              <>
                {t('settings.chatgptWebStepApp')}
                <span className="font-normal text-muted-foreground">{t('settings.chatgptWebStepAppTag')}</span>
              </>
            }
          >
            {!status.tunnelId ? (
              <p>{t('settings.chatgptWebStepAppPending')}</p>
            ) : (
              <>
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-2.5 rounded-md border px-2.5 py-2',
                    status.probeActive
                      ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
                      : 'border-amber-500/30 bg-amber-500/[0.06]'
                  )}
                >
                  <p className="min-w-[200px] flex-1 text-[12px] text-foreground/90">
                    {status.probeActive ? t('settings.chatgptWebProbeOn') : t('settings.chatgptWebProbeOff')}
                  </p>
                  <button
                    type="button"
                    className={status.probeActive ? secondaryButtonCls : primaryButtonCls}
                    disabled={busy === 'probe' || !status.configured || tunnelAsset?.status.state !== 'ready'}
                    onClick={() => void toggleProbe()}
                  >
                    {busy === 'probe' && <Loader2 className="h-3 w-3 animate-spin" />}
                    {status.probeActive ? t('settings.chatgptWebProbeStop') : t('settings.chatgptWebProbeStart')}
                  </button>
                </div>
                {status.configured && status.appRefreshRequired && (
                  <div
                    role="alert"
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-200"
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
                <button
                  type="button"
                  className="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  aria-expanded={appStepsExpanded}
                  onClick={() => setAppStepsOpen(!appStepsExpanded)}
                >
                  {appStepsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {t('settings.chatgptWebAppStepsToggle')}
                </button>
                {appStepsExpanded && (
                  <>
                    <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[12px] text-muted-foreground">
                      <li>
                        {t('settings.chatgptWebStepAppDevMode')}{' '}
                        <button
                          type="button"
                          className={linkButtonCls}
                          onClick={() => window.api.openExternalUrl(DEVELOPER_MODE_URL)}
                        >
                          <ExternalLink className="h-3 w-3" /> {t('settings.chatgptWebOpenDevMode')}
                        </button>
                      </li>
                      <li>
                        {t('settings.chatgptWebStepAppCreate', {
                          name: status.tunnelId,
                        })}{' '}
                        <button
                          type="button"
                          className={linkButtonCls}
                          onClick={() => window.api.openExternalUrl(CHATGPT_PLUGINS_URL)}
                        >
                          <ExternalLink className="h-3 w-3" /> {t('settings.chatgptWebOpenPlugins')}
                        </button>
                      </li>
                      <li>{t('settings.chatgptWebStepAppPermissions')}</li>
                      <li>{t('settings.chatgptWebStepAppRefresh')}</li>
                    </ol>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <input
                        className={cn(inputCls, 'w-[200px] py-1 text-[12px]')}
                        placeholder="Maestrly Bridge"
                        aria-label={t('settings.chatgptWebAppNameHint')}
                        value={appName}
                        onChange={(e) => setAppName(e.target.value)}
                        onBlur={() => {
                          if (appName.trim())
                            void api.chatGptWebConfigure({
                              appName: appName.trim(),
                            })
                        }}
                      />
                      <span className="text-[11px] text-muted-foreground">{t('settings.chatgptWebAppNameHint')}</span>
                    </div>
                  </>
                )}
              </>
            )}
          </SetupStep>

          <SetupStep
            index={4}
            last
            state={checks.trim() ? 'done' : 'manual'}
            title={
              <>
                {t('settings.chatgptWebStepChecks')}
                <span className="font-normal text-muted-foreground">{t('settings.chatgptWebStepChecksTag')}</span>
              </>
            }
          >
            <p>{t('settings.chatgptWebStepChecksHint')}</p>
            <textarea
              className={cn(inputCls, 'mt-2 h-20 w-full font-mono text-[11px]')}
              placeholder={t('settings.chatgptWebChecksPlaceholder')}
              aria-label={t('settings.chatgptWebStepChecks')}
              value={checks}
              onChange={(e) => setChecks(e.target.value)}
              onBlur={() => void api.chatGptWebSetChecks(checks)}
            />
          </SetupStep>
        </ol>
      </DetailSection>
      {messages}
    </div>
  )
}
