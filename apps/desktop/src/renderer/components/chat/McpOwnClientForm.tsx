import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
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

/**
 * The person's own OAuth client, for a server that does not register apps itself. The secret is sent to the host that
 * runs the server and is never read back.
 */
export function McpOwnClientForm({
  issuer,
  busy,
  onSave,
  onCancel,
}: {
  /** The authorization server the sign-in stopped at, when known. */
  issuer?: string
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
