import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import type { McpOAuthSummaryDto } from '../../../shared/chat'
import type { McpSignInActions } from './mcp-sign-in-actions'

export type { McpSignInActions } from './mcp-sign-in-actions'

/** One status for a server's sign-in: whether anything needs a sign-in, otherwise whether an account is signed in. */
export function signInStatus(oauth: McpOAuthSummaryDto | undefined): 'connected' | 'needs-auth' | undefined {
  if (!oauth) return undefined
  if (oauth.needsAuth || oauth.accounts.some((account) => account.status === 'needs-auth')) return 'needs-auth'
  return oauth.accounts.length ? 'connected' : undefined
}

/**
 * Sign-in of one remote MCP server: its status, and Sign in / Sign out. The browser part runs on this computer; the
 * server's host (this computer or a remote workspaces host) keeps the sign-in.
 */
export function McpSignIn({
  serverId,
  auth,
  onChanged,
  className,
  actions: providedActions,
}: {
  serverId: string
  auth: 'connected' | 'needs-auth' | undefined
  onChanged: () => void
  className?: string
  /** The host of the current context by default. */
  actions?: McpSignInActions
}) {
  const { t } = useTranslation('chat')
  const hostId = useHostId()
  const api = useHostApi()
  const actions: McpSignInActions = providedActions ?? {
    connect: (id) => window.api.chatMcpOAuthConnect(hostId, id),
    cancel: (id) => window.api.chatMcpOAuthCancel(hostId, id),
    forget: (id) => api.chatMcpOAuthForget(id),
  }
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )
  if (!auth && !waiting) return null

  const signIn = async () => {
    setWaiting(true)
    setError(null)
    try {
      const result = await actions.connect(serverId)
      if (!alive.current) return
      if (!result.ok && result.error !== 'cancelled') setError(t(`mcp.auth.error.${result.error}`))
    } catch {
      if (alive.current) setError(t('mcp.auth.error.failed'))
    } finally {
      if (alive.current) setWaiting(false)
      onChanged()
    }
  }

  return (
    <div className={cn('flex flex-col items-end gap-0.5', className)}>
      <div className="flex items-center gap-2 text-[11px]">
        {waiting ? (
          <>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('mcp.auth.waiting')}
            </span>
            <button
              type="button"
              onClick={() => void actions.cancel(serverId)}
              className="text-muted-foreground underline decoration-white/20 underline-offset-2 hover:text-foreground"
            >
              {t('mcp.auth.cancel')}
            </button>
          </>
        ) : auth === 'connected' ? (
          <>
            <span className="text-emerald-300/80">{t('mcp.auth.signedIn')}</span>
            <button
              type="button"
              onClick={() => void actions.forget(serverId).then(onChanged)}
              className="text-muted-foreground underline decoration-white/20 underline-offset-2 hover:text-foreground"
            >
              {t('mcp.auth.signOut')}
            </button>
          </>
        ) : (
          <>
            <span className="text-amber-300/90">{t('mcp.auth.needsSignIn')}</span>
            <button
              type="button"
              onClick={() => void signIn()}
              className="rounded border border-white/15 px-2 py-0.5 text-foreground hover:bg-white/[0.06]"
            >
              {t('mcp.auth.signIn')}
            </button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
