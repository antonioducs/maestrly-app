import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { HostView } from '../../../../shared/hosts'
import { CLAUDE_LOGIN_CODE_MAX_LENGTH, type ChatSubscriptionCodeResult } from '../../../../shared/chat'
import { CLAUDE_CODE_SETUP_DOCS_URL, claudeCodeSetupCommand, type ClaudeCodeSetupNeed } from './claude-code-setup'
import { cn } from '@/lib/utils'
import { inputCls, linkButtonCls, secondaryButtonCls } from './account-ui'

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={secondaryButtonCls}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 2000)
        })
      }
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? t('settings.claudeCodeCopied') : label}
    </button>
  )
}

/** How to install or update the Claude Code the subscription runs on, with the official command for the host. */
export function ClaudeCodeSetupNotice({
  need,
  host,
  checking,
  onCheckAgain,
}: {
  need: ClaudeCodeSetupNeed
  host: Pick<HostView, 'os' | 'remote' | 'label' | 'server'>
  checking: boolean
  onCheckAgain: () => void
}) {
  const { t } = useTranslation('chat')
  const command = claudeCodeSetupCommand(need, host.os)
  const hostName = host.label || host.server
  return (
    <div
      data-claude-code-setup={need}
      className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 text-[12px]"
    >
      <p className="font-medium text-amber-200">
        {t(need === 'install' ? 'settings.claudeCodeInstallTitle' : 'settings.claudeCodeUpdateTitle')}
      </p>
      <p className="mt-0.5 text-muted-foreground">
        {need === 'update'
          ? t('settings.claudeCodeUpdateHint')
          : host.remote && hostName
            ? t('settings.claudeCodeInstallHintRemote', { host: hostName })
            : t('settings.claudeCodeInstallHint')}
      </p>
      {need === 'install' && (
        <p className="mt-2 text-[11px] text-muted-foreground">{t(`settings.claudeCodeInstallShell_${host.os}`)}</p>
      )}
      <div className={cn('flex items-center gap-2', need === 'install' ? 'mt-1' : 'mt-2')}>
        <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded bg-black/30 px-2 py-1.5 font-mono text-[11.5px] text-foreground">
          {command}
        </code>
        <CopyButton text={command} label={t('settings.claudeCodeCopyCommand')} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          className={linkButtonCls}
          onClick={() => void window.api.openExternalUrl(CLAUDE_CODE_SETUP_DOCS_URL)}
        >
          {t('settings.claudeCodeInstallDocs')}
          <ExternalLink className="h-3 w-3" />
        </button>
        <button type="button" className={linkButtonCls} disabled={checking} onClick={onCheckAgain}>
          {checking && <Loader2 className="h-3 w-3 animate-spin" />}
          {t('settings.claudeCodeCheckAgain')}
        </button>
      </div>
    </div>
  )
}

const CODE_ERROR_KEYS: Record<NonNullable<ChatSubscriptionCodeResult['error']>, string> = {
  'invalid-code': 'settings.claudeSubscriptionCodeInvalid',
  'not-waiting': 'settings.claudeSubscriptionCodeExpired',
  'unknown-account': 'settings.claudeSubscriptionCodeFailed',
}

/**
 * The fallback of a Claude sign-in: a page that shows a code, for when the browser does not open (a Linux session
 * without a default browser) or its redirect cannot reach Claude Code (a remote host).
 */
export function ClaudeManualSignIn({
  manualUrl,
  submitCode,
}: {
  manualUrl: string
  submitCode: (code: string) => Promise<ChatSubscriptionCodeResult>
}) {
  const { t } = useTranslation('chat')
  const [code, setCode] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!code.trim() || state === 'sending') return
    setState('sending')
    setError(null)
    try {
      const result = await submitCode(code.trim())
      if (result.ok) {
        setCode('')
        setState('sent')
        return
      }
      setError(t(result.error ? CODE_ERROR_KEYS[result.error] : 'settings.claudeSubscriptionCodeFailed'))
    } catch {
      setError(t('settings.claudeSubscriptionCodeFailed'))
    }
    setState('idle')
  }
  return (
    <div
      data-claude-manual-sign-in
      className="mt-3 rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 text-[12px]"
    >
      <p className="font-medium text-amber-100">{t('settings.claudeSubscriptionManualTitle')}</p>
      <p className="mt-0.5 text-muted-foreground">{t('settings.claudeSubscriptionManualHint')}</p>
      <div className="mt-2 flex items-center gap-2">
        <code
          className="min-w-0 flex-1 select-all truncate rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-foreground/80"
          title={manualUrl}
        >
          {manualUrl}
        </code>
        <CopyButton text={manualUrl} label={t('settings.claudeSubscriptionManualCopy')} />
        <button type="button" className={secondaryButtonCls} onClick={() => void window.api.openExternalUrl(manualUrl)}>
          <ExternalLink className="h-3.5 w-3.5" />
          {t('settings.claudeSubscriptionManualOpen')}
        </button>
      </div>
      <form className="mt-2 flex items-end gap-2" onSubmit={(event) => void submit(event)}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          {t('settings.claudeSubscriptionCodeLabel')}
          <input
            className={cn(inputCls, 'font-mono')}
            value={code}
            maxLength={CLAUDE_LOGIN_CODE_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.claudeSubscriptionCodePlaceholder')}
            onChange={(event) => {
              setCode(event.target.value)
              setError(null)
              if (state === 'sent') setState('idle')
            }}
          />
        </label>
        <button type="submit" className={secondaryButtonCls} disabled={!code.trim() || state === 'sending'}>
          {state === 'sending' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('settings.claudeSubscriptionCodeSubmit')}
        </button>
      </form>
      {state === 'sent' && (
        <p role="status" className="mt-2 text-muted-foreground">
          {t('settings.claudeSubscriptionCodeSent')}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
