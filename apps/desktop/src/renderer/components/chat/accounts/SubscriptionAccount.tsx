import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { useHostApi } from '@/lib/hosts/host-context'
import { useHostInfo } from '@/lib/hosts/use-hosts'
import { environmentSubscriptionLogin } from '@/lib/fleet/use-bot-login'
import { BotLoginDialog } from '@/components/fleet/BotLoginDialog'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type {
  ChatConfig,
  ChatSubscriptionAuthStatus,
  ChatSubscriptionLoginResult,
  ChatSubscriptionProviderKind,
  ChatSubscriptionUsage,
} from '../../../../shared/chat'
import type { RuntimeAssetId, RuntimeAssetInfo } from '../../../../shared/runtime-assets'
import { accountPoolFor } from '../account-pool'
import { SubscriptionUsagePanel } from '../SubscriptionUsagePanel'
import { supportsSubscriptionUsage } from '../subscription-usage-presentation'
import {
  assetProgress,
  formatBytes,
  runtimeAssetDownloadBytes,
  runtimeAssetVersion,
} from '../runtime-asset-presentation'
import {
  subscriptionPlanLabel,
  type SubscriptionAccountEntry,
  type SubscriptionAccountSnapshot,
} from './account-entries'
import {
  DetailBackButton,
  DetailHeader,
  DetailSection,
  iconButtonCls,
  inputCls,
  ProviderMark,
  secondaryButtonCls,
} from './account-ui'
import { AccountPoolEditor } from './AccountPoolEditor'
import { FailoverRouteEditor } from './FailoverRouteEditor'
import { ProviderModelFilter } from './ProviderModelFilter'
import { ClaudeCodeSetupNotice, ClaudeManualSignIn } from './ClaudeSubscriptionHelp'
import { claudeCodeSetupNeed } from './claude-code-setup'
import { DeviceCodeSignIn } from './DeviceCodeSignIn'
import { deviceSignInUrl } from './device-sign-in'

export const PROVIDER_RUNTIME_ASSET: Partial<Record<ChatSubscriptionProviderKind, RuntimeAssetId>> = {
  'codex-subscription': 'codex-runtime',
  'github-copilot-subscription': 'github-copilot-runtime',
  'antigravity-subscription': 'antigravity-acp-runtime',
}

export type SubscriptionCopyPrefix =
  | 'codexSubscription'
  | 'githubCopilotSubscription'
  | 'claudeSubscription'
  | 'grokSubscription'
  | 'cursorSubscription'
  | 'antigravitySubscription'

export const subscriptionProviderCopy: Record<
  ChatSubscriptionProviderKind,
  { prefix: SubscriptionCopyPrefix; buttonClass: string }
> = {
  'codex-subscription': { prefix: 'codexSubscription', buttonClass: 'bg-emerald-600 hover:bg-emerald-500' },
  'github-copilot-subscription': { prefix: 'githubCopilotSubscription', buttonClass: 'bg-sky-600 hover:bg-sky-500' },
  'claude-subscription': { prefix: 'claudeSubscription', buttonClass: 'bg-orange-600 hover:bg-orange-500' },
  'cursor-subscription': { prefix: 'cursorSubscription', buttonClass: 'bg-violet-600 hover:bg-violet-500' },
  'grok-subscription': { prefix: 'grokSubscription', buttonClass: 'bg-zinc-700 hover:bg-zinc-600' },
  'antigravity-subscription': { prefix: 'antigravitySubscription', buttonClass: 'bg-blue-600 hover:bg-blue-500' },
}

/** The name shown for a slot: its label, or "Default account" for an unlabeled default slot. */
export function useSubscriptionAccountTitle() {
  const { t } = useTranslation('chat')
  return (entry: Pick<SubscriptionAccountEntry, 'accountId' | 'accountLabel'>): string =>
    entry.accountLabel?.trim() || (entry.accountId ?? t('settings.accountDefaultLabel'))
}

export function SubscriptionAccount({
  entry,
  config,
  selected,
  autoLogin,
  onAutoLoginHandled,
  onSnapshot,
  onConnectAnother,
  onBack,
  showSubscriptionFailover,
  onChanged,
  onModelFilterChanged,
}: {
  entry: SubscriptionAccountEntry
  config: ChatConfig
  selected: boolean
  /** Start the sign-in once the slot's status is known, as asked from the Add account dialog. */
  autoLogin: boolean
  onAutoLoginHandled: () => void
  onSnapshot: (key: string, snapshot: SubscriptionAccountSnapshot | null) => void
  onConnectAnother: (kind: ChatSubscriptionProviderKind) => void
  onBack: () => void
  showSubscriptionFailover: boolean
  onChanged: () => void
  onModelFilterChanged: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const host = useHostInfo()
  const titleFor = useSubscriptionAccountTitle()
  const { providerKind, provider, accountId, accountLabel } = entry
  const environmentLogin = environmentSubscriptionLogin(providerKind, host)
  const [environmentLoginOpen, setEnvironmentLoginOpen] = useState(false)
  const [status, setStatus] = useState<ChatSubscriptionAuthStatus | null>(null)
  const [loginInstructions, setLoginInstructions] = useState<ChatSubscriptionLoginResult | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'login' | 'logout' | null>(null)
  const [usage, setUsage] = useState<ChatSubscriptionUsage | null>(null)
  const [usageBusy, setUsageBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [copiedLoginText, setCopiedLoginText] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const runtimeId = PROVIDER_RUNTIME_ASSET[providerKind]
  const [runtime, setRuntime] = useState<RuntimeAssetInfo | null>(null)
  const runtimeStateRef = useRef<RuntimeAssetInfo['status']['state'] | null>(null)
  const runtimeInstallInProgressRef = useRef(false)
  const runtimeStatusRefreshInProgressRef = useRef(false)
  const usageRequestRef = useRef(0)
  /** Bumped by sign-out: the answer of a sign-in it cancelled is not an error to show. */
  const loginAttemptRef = useRef(0)
  const renameRequestedRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const copy = subscriptionProviderCopy[providerKind]
  const copyKey = (suffix: string) => `settings.${copy.prefix}${suffix}`
  const usageSupported = supportsSubscriptionUsage(providerKind)
  const statusErrorText = (value: ChatSubscriptionAuthStatus | null | undefined): string | undefined =>
    value?.errorCode === 'claude-authentication-required'
      ? t('messages.claudeAuthenticationRequired')
      : value?.errorCode === 'subscription-provider-not-configured'
        ? t('settings.subscriptionNotConfigured', { provider: t(`settings.accountProviderName_${providerKind}`) })
        : value?.error

  useEffect(() => {
    onSnapshot(entry.key, { status, usage, runtime })
  }, [entry.key, onSnapshot, status, usage, runtime])
  useEffect(() => () => onSnapshot(entry.key, null), [entry.key, onSnapshot])

  const refreshUsage = useCallback(
    async (force = false): Promise<ChatSubscriptionUsage | null> => {
      if (!usageSupported) return null
      const request = ++usageRequestRef.current
      setUsageBusy(true)
      try {
        const next = await api.chatSubscriptionUsage(providerKind, force, accountId)
        if (request === usageRequestRef.current) setUsage(next)
        return next
      } catch (error) {
        const failed: ChatSubscriptionUsage = {
          state: 'error',
          providerKind,
          accountId,
          error: error instanceof Error ? error.message : String(error),
        }
        if (request === usageRequestRef.current) setUsage(failed)
        return failed
      } finally {
        if (request === usageRequestRef.current) setUsageBusy(false)
      }
    },
    [accountId, providerKind, usageSupported, api]
  )

  const refreshStatus = async (force = false): Promise<ChatSubscriptionAuthStatus | null> => {
    setBusy((current) => current ?? 'refresh')
    setActionError(null)
    try {
      const next = await api.chatSubscriptionStatus(providerKind, force, accountId)
      setStatus(next)

      onChanged()
      return next
    } catch (error) {
      setStatus({
        state: 'error',
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    } finally {
      setBusy((current) => (current === 'refresh' ? null : current))
    }
  }

  useEffect(() => {
    void refreshStatus()
    return api.onChatSubscriptionStatus(providerKind, (next) => {
      if ((next.accountId ?? null) !== accountId) return
      setStatus(next)
      setBusy(null)
      setActionError(null)
      if (next.state === 'signed-in' || next.state === 'signed-out') setLoginInstructions(null)
      if (next.state === 'signed-in') void refreshUsage(true)
      else {
        usageRequestRef.current += 1
        setUsage(null)
        setUsageBusy(false)
      }
      onChanged()
    })
    // `onChanged` is the stable config refresher owned by ApiKeySettings.
  }, [accountId, api])

  useEffect(() => {
    if (status?.state === 'signed-in' && usageSupported) {
      void refreshUsage()
      return
    }
    usageRequestRef.current += 1
    setUsage(null)
    setUsageBusy(false)
  }, [refreshUsage, status?.state, usageSupported])

  useEffect(() => {
    if (!runtimeId) return
    void api.runtimeAssetStatus(runtimeId).then((next) => {
      if (runtimeStateRef.current !== null) return
      runtimeStateRef.current = next.status.state
      setRuntime(next)
    })
    return api.onRuntimeAssetChanged((next) => {
      if (next.id !== runtimeId) return
      const previousState = runtimeStateRef.current
      runtimeStateRef.current = next.status.state
      setRuntime(next)
      if (
        next.status.state === 'ready' &&
        previousState !== 'ready' &&
        !runtimeInstallInProgressRef.current &&
        !runtimeStatusRefreshInProgressRef.current
      ) {
        runtimeStatusRefreshInProgressRef.current = true
        void refreshStatus(true).finally(() => {
          runtimeStatusRefreshInProgressRef.current = false
        })
      }
    })
  }, [runtimeId, api])

  const login = async () => {
    const attempt = ++loginAttemptRef.current
    setBusy('login')
    setActionError(null)
    try {
      // A bot's image runtime needs no install; a managed one does.
      if (runtimeId && runtime?.status.state !== 'ready' && runtime?.provided?.active !== true) {
        runtimeInstallInProgressRef.current = true
        try {
          const installed =
            runtime?.status.state === 'failed' || runtime?.status.state === 'corrupt'
              ? await api.runtimeAssetRepair(runtimeId)
              : await api.runtimeAssetInstall(runtimeId)
          runtimeStateRef.current = installed.status.state
          setRuntime(installed)
          if (installed.status.state !== 'ready')
            throw new Error(installed.status.error || t('settings.componentInstallFailed'))
        } finally {
          runtimeInstallInProgressRef.current = false
        }

        const recovered = await refreshStatus(true)
        if (recovered?.authenticated || recovered?.state === 'signed-in') {
          setLoginInstructions(null)
          return
        }
        if (recovered?.state !== 'signed-out') {
          throw new Error(statusErrorText(recovered) || t(copyKey('LoginFailed')))
        }
      }
      // A workspaces host would open the provider's page on the server: its environment relays it to this computer.
      if (environmentLogin) {
        setEnvironmentLoginOpen(true)
        return
      }
      const result = await api.chatSubscriptionLogin(providerKind, accountId)
      if (attempt !== loginAttemptRef.current) return
      if (!result.ok) {
        if (result.status) setStatus(result.status)
        throw new Error(statusErrorText(result.status) || result.error || t(copyKey('LoginFailed')))
      }
      setLoginInstructions(result)
      // The sign-in page can be broadcast before this reply arrives; keep it.
      setStatus((current) =>
        current?.state === 'signing-in' && current.authUrl
          ? current
          : (result.status ?? { state: 'signing-in', authenticated: false })
      )
      const loginUrl = result.authUrl ?? deviceSignInUrl(providerKind, result.verificationUrl)
      if (loginUrl) window.api.openExternalUrl(loginUrl)
      onChanged()
    } catch (error) {
      if (attempt === loginAttemptRef.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy((current) => (current === 'login' ? null : current))
    }
  }

  const logout = async () => {
    loginAttemptRef.current += 1
    setBusy('logout')
    setActionError(null)
    try {
      const result = await api.chatSubscriptionLogout(providerKind, accountId)
      if (!result.ok) {
        throw new Error(result.error || t(copyKey('LogoutFailed')))
      }
      setLoginInstructions(null)
      setStatus(result.status ?? { state: 'signed-out', authenticated: false })
      usageRequestRef.current += 1
      setUsage(null)
      setUsageBusy(false)
      onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const removeAccount = async () => {
    if (!accountId) return
    if (
      !confirm(
        t('settings.confirmRemoveAccount', {
          label: accountLabel ?? accountId,
        })
      )
    )
      return
    setBusy('logout')
    setActionError(null)
    try {
      const result = await api.chatSubscriptionAccountRemove(accountId)
      if (!result.ok) throw new Error(result.error || t('settings.accountRemoveFailed'))
      onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const commitRename = async () => {
    if (accountId && renaming?.trim()) {
      setActionError(null)
      const result = await api.chatSubscriptionAccountRename(accountId, renaming.trim())
      if (!result.ok) setActionError(result.error || t('settings.accountRenameFailed'))
      onChanged()
    }
    setRenaming(null)
  }

  const signedIn = status?.state === 'signed-in'
  const signingIn = status?.state === 'signing-in'
  const pendingLoginUrl = signingIn ? status?.authUrl : undefined
  const unavailable = status?.state === 'unavailable'
  // Installing the runtime cannot fix a build without the provider's OAuth configuration, so it is not offered.
  const notConfigured = status?.errorCode === 'subscription-provider-not-configured'
  const claudeSetup = providerKind === 'claude-subscription' ? claudeCodeSetupNeed(status) : null

  const deviceLoginUrl = signingIn ? deviceSignInUrl(providerKind, loginInstructions?.verificationUrl) : null

  useEffect(() => {
    if (copiedLoginText === null) return
    const timer = setTimeout(() => setCopiedLoginText(null), 2_000)
    return () => clearTimeout(timer)
  }, [copiedLoginText])

  const copyLoginText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedLoginText(text)
    } catch {
      // The text stays selectable for a manual copy.
    }
  }
  const runtimeActive =
    runtime !== null && ['downloading', 'verifying', 'installing', 'removing'].includes(runtime.status.state)
  const runtimeReady = !runtimeId || runtime?.status.state === 'ready' || runtime?.provided?.active === true
  const runtimeOffered = runtime !== null && runtime.status.state !== 'ready' && !notConfigured
  const loginDisabled =
    busy !== null ||
    signingIn ||
    notConfigured ||
    (runtimeReady && unavailable) ||
    (runtimeId !== undefined && runtime === null)

  const renameOpen = renaming !== null
  useEffect(() => {
    if (!renameOpen) return
    // Wait for the menu that opened the field to close and release focus.
    const timer = setTimeout(() => renameInputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [renameOpen])

  useEffect(() => {
    if (!autoLogin || status === null || (runtimeId !== undefined && runtime === null) || busy !== null) return
    onAutoLoginHandled()
    if (signedIn || loginDisabled) return
    void login()
  }, [autoLogin, status, runtime, busy])

  if (!selected) return null

  const statusLabel = !status
    ? t('settings.loading')
    : signedIn
      ? t(copyKey('Connected'))
      : signingIn
        ? t(copyKey('Waiting'))
        : notConfigured
          ? t('settings.subscriptionNotConfiguredShort')
          : unavailable
            ? t(copyKey('Unavailable'))
            : t(copyKey('Disconnected'))
  const identity = status?.username ?? status?.email
  const plan = subscriptionPlanLabel(status?.planType, t)
  const runtimeVersion = runtime ? runtimeAssetVersion(runtime) : null
  const providerName = t(`settings.accountProviderName_${providerKind}`)

  const refreshAll = async () => {
    const next = await refreshStatus(true)
    if (next?.state === 'signed-in') await refreshUsage(true)
  }

  const defaultEntry = config.providers.find((entry) => entry.kind === providerKind && !entry.accountId)
  const defaultLabel = titleFor({ accountId: null, accountLabel: defaultEntry?.accountLabel })
  const accountPool = accountPoolFor(config, providerKind)
  const showUsage = signedIn && usageSupported && usage?.state !== 'unsupported' && (usage !== null || usageBusy)

  return (
    <div data-subscription-provider={providerKind} data-subscription-account={accountId ?? 'default'}>
      <DetailBackButton onBack={onBack} />
      <DetailHeader
        mark={<ProviderMark kind={providerKind} size="lg" />}
        title={
          accountId && renaming !== null ? (
            <input
              ref={renameInputRef}
              className={cn(inputCls, 'py-1 text-[13px] font-normal')}
              value={renaming}
              aria-label={t('settings.renameAccountTitle')}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename()
                if (e.key === 'Escape') setRenaming(null)
              }}
              onBlur={() => void commitRename()}
            />
          ) : (
            titleFor(entry)
          )
        }
        status={
          <span
            className={cn(
              'text-[12px]',
              signedIn
                ? 'text-emerald-400'
                : signingIn
                  ? 'text-amber-300'
                  : status?.state === 'error'
                    ? 'text-rose-300'
                    : 'text-muted-foreground'
            )}
          >
            {statusLabel}
          </span>
        }
        subtitle={t(copyKey('Heading'))}
        actions={
          <>
            <button
              type="button"
              onClick={() => void refreshAll()}
              disabled={busy !== null || usageBusy}
              className={iconButtonCls}
              title={t(copyKey('Refresh'))}
              aria-label={t(copyKey('Refresh'))}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', (busy === 'refresh' || usageBusy) && 'animate-spin')} />
            </button>
            {signedIn || signingIn ? (
              <button
                type="button"
                onClick={() => void logout()}
                disabled={busy !== null}
                className={secondaryButtonCls}
              >
                {busy === 'logout' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="h-3.5 w-3.5" />
                )}
                {signingIn ? t('settings.cancel') : t(copyKey('Logout'))}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void login()}
                disabled={loginDisabled}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-50',
                  copy.buttonClass
                )}
              >
                {busy === 'login' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogIn className="h-3.5 w-3.5" />
                )}
                {runtime && runtimeOffered
                  ? runtime.status.state === 'failed' || runtime.status.state === 'corrupt'
                    ? t('settings.componentRetryAndConnect')
                    : t('settings.componentInstallAndConnect')
                  : t(copyKey('Login'))}
                <ExternalLink className="h-3 w-3" />
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={iconButtonCls}
                  disabled={busy !== null}
                  aria-label={t('settings.accountMoreActions')}
                  title={t('settings.accountMoreActions')}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[13rem]"
                onCloseAutoFocus={(event) => {
                  // The rename field takes focus; handing it back to the trigger would blur and commit it at once.
                  if (renameRequestedRef.current) event.preventDefault()
                  renameRequestedRef.current = false
                }}
              >
                {accountId && (
                  <DropdownMenuItem
                    onSelect={() => {
                      renameRequestedRef.current = true
                      setRenaming(accountLabel ?? '')
                    }}
                  >
                    <Pencil /> {t('settings.renameAccountTitle')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => onConnectAnother(providerKind)}>
                  <Plus /> {t('settings.accountConnectAnother', { provider: providerName })}
                </DropdownMenuItem>
                {accountId && (
                  <DropdownMenuItem destructive onSelect={() => void removeAccount()}>
                    <Trash2 /> {t('settings.removeAccountTitle')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {signedIn && (identity || plan) && (
        <p className="mt-3 text-[12px] text-foreground/80">{[identity, plan].filter(Boolean).join(' · ')}</p>
      )}
      {!signedIn && <p className="mt-3 text-[12px] text-muted-foreground">{t(copyKey('Description'))}</p>}
      {runtime && runtimeOffered && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 text-[12px]">
          <p className="font-medium text-amber-200">
            {t('settings.componentRequired', {
              name: t(`settings.componentName_${runtime.id}`),
            })}
          </p>
          <p className="mt-0.5 text-muted-foreground" data-runtime-install-version={runtimeVersion ?? 'latest'}>
            {runtimeVersion ? (
              <>
                v{runtimeVersion} ·{' '}
                {t('settings.componentSizesEstimate', {
                  download: formatBytes(runtimeAssetDownloadBytes(runtime)),
                  installed: formatBytes(runtime.status.diskUsageBytes || runtime.unpackedBytes),
                })}
              </>
            ) : (
              t('settings.componentLatestVersion')
            )}
          </p>
          {runtimeActive && runtime.status.state !== 'removing' && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-amber-400"
                  style={{
                    width: `${assetProgress(runtime)}%`,
                  }}
                />
              </div>
              <button
                type="button"
                className="text-amber-200 hover:text-white"
                onClick={() => void api.runtimeAssetCancel(runtime.id)}
              >
                {t('settings.componentCancel')}
              </button>
            </div>
          )}
        </div>
      )}
      {signedIn && status.storageMode === 'memory' ? (
        <p className="mt-2 text-[12px] text-amber-300">{t('settings.subscriptionMemoryOnly')}</p>
      ) : null}
      {claudeSetup && (
        <ClaudeCodeSetupNotice
          need={claudeSetup}
          host={host}
          checking={busy === 'refresh'}
          savedSignIn={status?.savedSignIn ? { email: status.email ?? null } : null}
          onCheckAgain={() => void refreshAll()}
        />
      )}
      {signingIn && providerKind === 'claude-subscription' && loginInstructions?.manualUrl && (
        <ClaudeManualSignIn
          manualUrl={loginInstructions.manualUrl}
          submitCode={(code) => api.chatClaudeSubscriptionSubmitCode(code, accountId)}
        />
      )}
      {pendingLoginUrl && (
        <div
          className="mt-3 rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5"
          data-subscription-login-link
        >
          <p className="text-[12px] text-amber-100">{t('settings.subscriptionLoginLinkHint')}</p>
          <code className="mt-1.5 block max-h-20 select-all overflow-y-auto break-all font-mono text-[11px] text-foreground/90">
            {pendingLoginUrl}
          </code>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={secondaryButtonCls} onClick={() => void copyLoginText(pendingLoginUrl)}>
              {copiedLoginText === pendingLoginUrl ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copiedLoginText === pendingLoginUrl
                ? t('settings.subscriptionLoginLinkCopied')
                : t('settings.subscriptionLoginLinkCopy')}
            </button>
            <button
              type="button"
              className={secondaryButtonCls}
              onClick={() => window.api.openExternalUrl(pendingLoginUrl)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('settings.subscriptionLoginLinkOpen')}
            </button>
          </div>
        </div>
      )}
      {signingIn && loginInstructions?.userCode && (
        <DeviceCodeSignIn
          hint={t(copyKey('DeviceCodeHint'))}
          userCode={loginInstructions.userCode}
          verificationUrl={deviceLoginUrl}
          copied={copiedLoginText}
          onCopy={(text) => void copyLoginText(text)}
          onOpen={(url) => window.api.openExternalUrl(url)}
          buttonClassName={secondaryButtonCls}
        />
      )}
      {(actionError || (status?.error && !claudeSetup)) && (
        <p className="mt-2 text-[12px] text-destructive">{actionError || statusErrorText(status)}</p>
      )}
      {!provider && signedIn && <p className="mt-2 text-[12px] text-amber-300">{t(copyKey('ProviderPending'))}</p>}

      {showUsage && (
        <DetailSection title={t('settings.subscriptionUsageHeading')}>
          <SubscriptionUsagePanel usage={usage} loading={usageBusy} showHeading={false} />
        </DetailSection>
      )}
      {accountPool && (
        <AccountPoolEditor
          pool={accountPool}
          providerId={entry.key}
          config={config}
          defaultLabel={defaultLabel}
          disconnectedLabel={t(copyKey('Disconnected'))}
          onChanged={onChanged}
        />
      )}
      {showSubscriptionFailover && (
        <FailoverRouteEditor
          primaryProviderId={entry.key}
          defaultLabel={defaultLabel}
          disconnectedLabel={t(copyKey('Disconnected'))}
          config={config}
          onChanged={onChanged}
        />
      )}
      {provider && signedIn && <ProviderModelFilter providerId={provider.id} onFilterChanged={onModelFilterChanged} />}
      {environmentLogin && environmentLoginOpen && (
        <BotLoginDialog
          subject={{
            target: { environmentId: environmentLogin.environmentId },
            name: host.label,
            running: true,
            serverId: environmentLogin.serverId,
          }}
          kind={environmentLogin.kind}
          slot={accountId ?? 'default'}
          open
          onClose={() => {
            setEnvironmentLoginOpen(false)
            void refreshStatus(true)
          }}
        />
      )}
    </div>
  )
}
