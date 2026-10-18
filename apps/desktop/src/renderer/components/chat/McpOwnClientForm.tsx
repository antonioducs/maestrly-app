import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

const inputCls =
  'h-8 w-full rounded-md border border-border bg-white/[0.03] px-2 text-[12px] text-foreground outline-none focus:border-white/30'

/** Whether an authorization server is Google's, for its step-by-step help. */
function isGoogle(issuer: string | undefined): boolean {
  if (!issuer) return false
  try {
    return new URL(issuer).hostname === 'accounts.google.com'
  } catch {
    return false
  }
}

/** The redirect URL the person registers with their own client's provider, with a button that copies it. */
export function McpRedirectUrl({ url, label }: { url: string; label?: string }) {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="mcp-redirect-url">
      {label && <span className="text-[11px] text-muted-foreground">{label}</span>}
      <code className="min-w-0 select-all break-all font-mono text-[11px] text-foreground">{url}</code>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[11px] text-foreground hover:bg-white/[0.06]"
        onClick={() =>
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 2000)
          })
        }
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? t('mcp.accounts.ownClient.copied') : t('mcp.accounts.ownClient.copy')}
      </button>
    </div>
  )
}

/**
 * The person's own OAuth client, for a server that does not register apps itself. The secret is sent to the host that
 * runs the server and is never read back.
 */
export function McpOwnClientForm({
  issuer,
  redirectUri,
  busy,
  onSave,
  onCancel,
}: {
  /** The authorization server the sign-in stopped at, when known. */
  issuer?: string
  /** Where every sign-in with this client returns: the person adds it to the client. */
  redirectUri: string
  busy?: boolean
  onSave: (client: { clientId: string; clientSecret?: string }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('chat')
  const id = useId()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const valid = clientId.trim().length > 0 && clientId.length <= 4096 && clientSecret.length <= 4096
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] p-2.5"
      data-testid="mcp-own-client"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !busy) onSave({ clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) })
      }}
    >
      <div className="text-[12px] font-medium text-foreground">{t('mcp.accounts.ownClient.heading')}</div>
      <p className="text-[11px] text-muted-foreground">{t('mcp.accounts.ownClient.help')}</p>
      <McpRedirectUrl url={redirectUri} label={t('mcp.accounts.ownClient.redirect')} />
      {isGoogle(issuer) && (
        <div className="text-[11px] text-muted-foreground">
          <div className="font-medium text-foreground">{t('mcp.accounts.ownClient.googleTitle')}</div>
          <ol className="list-decimal pl-4">
            <li>{t('mcp.accounts.ownClient.google1')}</li>
            <li>{t('mcp.accounts.ownClient.google2')}</li>
            <li>{t('mcp.accounts.ownClient.google3')}</li>
          </ol>
        </div>
      )}
      <label htmlFor={`${id}-id`} className="text-[11px] text-muted-foreground">
        {t('mcp.accounts.ownClient.clientId')}
      </label>
      <input
        id={`${id}-id`}
        className={inputCls}
        value={clientId}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setClientId(event.target.value)}
        disabled={busy}
      />
      <label htmlFor={`${id}-secret`} className="text-[11px] text-muted-foreground">
        {t('mcp.accounts.ownClient.clientSecret')}
      </label>
      <input
        id={`${id}-secret`}
        type="password"
        className={inputCls}
        value={clientSecret}
        autoComplete="off"
        onChange={(event) => setClientSecret(event.target.value)}
        disabled={busy}
      />
      <p className="text-[11px] text-muted-foreground">{t('mcp.accounts.ownClient.secretKept')}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('mcp.accounts.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>
          {busy && <Loader2 className="animate-spin" />}
          {t('mcp.accounts.ownClient.save')}
        </Button>
      </div>
    </form>
  )
}
