import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import type { McpOAuthAccountDto, McpOAuthConnectOptions, McpOAuthSummaryDto } from '../../../shared/chat'
import type { PluginScope } from '../../../shared/plugins'
import { PluginScopePicker, scopeIsComplete } from '../plugins/PluginScopePicker'
import { type McpAccountActions, validLabel } from './mcp-account-actions'
import { McpOwnClientForm } from './McpOwnClientForm'

export type { McpAccountActions } from './mcp-account-actions'

const linkCls = 'text-muted-foreground underline decoration-white/20 underline-offset-2 hover:text-foreground'

/**
 * The signed-in accounts of one remote MCP server: each with its name, e-mail, status and the conversations it serves,
 * plus adding an account, signing one in again, renaming, removing, and the person's own OAuth client for servers that
 * do not register apps. The browser part runs on this computer; the server's host keeps the accounts.
 */
export function McpAccounts({
  serverId,
  oauth,
  onChanged,
  className,
  actions: providedActions,
}: {
  serverId: string
  oauth: McpOAuthSummaryDto | undefined
  onChanged: () => void
  className?: string
  /** The host of the current context by default. */
  actions?: McpAccountActions
}) {
  const { t } = useTranslation('chat')
  const hostId = useHostId()
  const api = useHostApi()
  const actions = useMemo<McpAccountActions>(
    () =>
      providedActions ?? {
        connect: (id, options) => window.api.chatMcpOAuthConnect(hostId, id, options),
        cancel: (id) => window.api.chatMcpOAuthCancel(hostId, id),
        forget: (id, accountId) => api.chatMcpOAuthForget(id, accountId),
        patchAccount: (id, accountId, patch) => api.chatMcpOAuthPatchAccount(id, accountId, patch),
        setClient: (id, client) => api.chatMcpOAuthSetClient(id, client),
        listProjects: async () =>
          (await api.listWorkspaces()).map((workspace) => ({ id: workspace.id, name: workspace.name })),
      },
    [providedActions, hostId, api]
  )
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ownClient, setOwnClient] = useState<{ issuer?: string; retry: McpOAuthConnectOptions } | null>(null)
  const [savingClient, setSavingClient] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; value: string; error?: string } | null>(null)
  const [scoping, setScoping] = useState<{ id: string; scope: PluginScope } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  if (!oauth && !waiting && !ownClient) return null
  const accounts = oauth?.accounts ?? []

  const connect = async (options: McpOAuthConnectOptions = {}) => {
    setWaiting(true)
    setError(null)
    try {
      const result = await actions.connect(serverId, options)
      if (!alive.current) return
      if (result.ok) return
      if (result.error === 'registration-unsupported') setOwnClient({ issuer: result.issuer, retry: options })
      else if (result.error !== 'cancelled') setError(t(`mcp.accounts.error.${result.error}`))
    } catch {
      if (alive.current) setError(t('mcp.accounts.error.failed'))
    } finally {
      if (alive.current) setWaiting(false)
      onChanged()
    }
  }

  const saveClient = async (client: { clientId: string; clientSecret?: string }) => {
    const retry = ownClient?.retry ?? {}
    setSavingClient(true)
    try {
      const saved = await actions.setClient(serverId, client)
      if (!alive.current) return
      if (!saved.ok) {
        setError(t('mcp.accounts.ownClient.removeFailed'))
        return
      }
      setOwnClient(null)
      onChanged()
      await connect(retry)
    } finally {
      if (alive.current) setSavingClient(false)
    }
  }

  const rename = async (account: McpOAuthAccountDto, value: string) => {
    const others = accounts.filter((item) => item.id !== account.id).map((item) => item.label)
    const check = validLabel(value, others)
    if (check !== 'ok') {
      setRenaming({
        id: account.id,
        value,
        error: t(check === 'taken' ? 'mcp.accounts.labelTaken' : 'mcp.accounts.labelInvalid'),
      })
      return
    }
    const result = await actions.patchAccount(serverId, account.id, { label: value.trim() })
    if (!alive.current) return
    if (!result.ok)
      setRenaming({
        id: account.id,
        value,
        error: t(
          result.error === 'label-taken'
            ? 'mcp.accounts.labelTaken'
            : result.error === 'invalid-label'
              ? 'mcp.accounts.labelInvalid'
              : 'mcp.accounts.error.failed'
        ),
      })
    else {
      setRenaming(null)
      onChanged()
    }
  }

  const saveScope = async (account: McpOAuthAccountDto, scope: PluginScope) => {
    const result = await actions.patchAccount(serverId, account.id, { scope })
    if (!alive.current) return
    if (!result.ok) setError(t('mcp.accounts.error.failed'))
    else {
      setScoping(null)
      onChanged()
    }
  }

  const scopeText = (scope: PluginScope) =>
    scope.kind === 'global'
      ? t('mcp.accounts.scopeGlobal')
      : t('mcp.accounts.scopeProjects', { count: scope.workspaceIds.length })

  return (
    <div className={cn('flex flex-col gap-1.5 text-[11px]', className)} data-testid="mcp-accounts">
      {accounts.map((account) => (
        <div
          key={account.id}
          role="group"
          aria-label={t('mcp.accounts.accountActions', { label: account.label })}
          data-account={account.label}
          className="flex flex-col gap-1 rounded-md border border-white/[0.06] px-2 py-1.5"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{account.label}</span>
            {account.email && account.email !== account.label && (
              <span className="text-muted-foreground">{account.email}</span>
            )}
            <span className={account.status === 'connected' ? 'text-emerald-300/80' : 'text-amber-300/90'}>
              {account.status === 'connected' ? t('mcp.accounts.signedIn') : t('mcp.accounts.needsSignIn')}
            </span>
            {actions.listProjects && <span className="text-muted-foreground">{scopeText(account.scope)}</span>}
            <span className="min-w-0 flex-1" />
            {account.status === 'needs-auth' && !waiting && (
              <button
                type="button"
                className="rounded border border-white/15 px-2 py-0.5 text-foreground hover:bg-white/[0.06]"
                onClick={() => void connect({ accountId: account.id })}
              >
                {t('mcp.accounts.signInAgain')}
              </button>
            )}
            <button
              type="button"
              className={linkCls}
              onClick={() => setRenaming({ id: account.id, value: account.label })}
            >
              {t('mcp.accounts.rename')}
            </button>
            {actions.listProjects && (
              <button
                type="button"
                className={linkCls}
                onClick={() => setScoping({ id: account.id, scope: account.scope })}
              >
                {t('mcp.accounts.change')}
              </button>
            )}
            <button
              type="button"
              className={linkCls}
              onClick={() => void Promise.resolve(actions.forget(serverId, account.id)).then(onChanged)}
            >
              {t('mcp.accounts.remove')}
            </button>
          </div>
          {renaming?.id === account.id && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void rename(account, renaming.value)
              }}
            >
              <input
                aria-label={t('mcp.accounts.label')}
                className="h-7 min-w-40 flex-1 rounded-md border border-border bg-white/[0.03] px-2 text-[12px] text-foreground outline-none focus:border-white/30"
                value={renaming.value}
                maxLength={60}
                onChange={(event) => setRenaming({ id: account.id, value: event.target.value })}
              />
              <Button type="submit" size="sm" className="h-7">
                {t('mcp.accounts.save')}
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setRenaming(null)}>
                {t('mcp.accounts.cancel')}
              </Button>
              {renaming.error && (
                <p role="alert" className="w-full text-destructive">
                  {renaming.error}
                </p>
              )}
            </form>
          )}
          {scoping?.id === account.id && actions.listProjects && (
            <div className="flex flex-col gap-2">
              <PluginScopePicker
                listProjects={actions.listProjects}
                value={scoping.scope}
                onChange={(scope) => setScoping({ id: account.id, scope })}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setScoping(null)}>
                  {t('mcp.accounts.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7"
                  disabled={!scopeIsComplete(scoping.scope)}
                  onClick={() => void saveScope(account, scoping.scope)}
                >
                  {t('mcp.accounts.save')}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      {oauth?.client && !ownClient && (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span className="font-mono">{t('mcp.accounts.ownClient.current', { clientId: oauth.client.clientId })}</span>
          <button type="button" className={linkCls} onClick={() => setOwnClient({ retry: {} })}>
            {t('mcp.accounts.change')}
          </button>
          <button
            type="button"
            className={linkCls}
            onClick={() => void actions.setClient(serverId, null).then(onChanged)}
          >
            {t('mcp.accounts.ownClient.remove')}
          </button>
        </div>
      )}
      {ownClient && (
        <McpOwnClientForm
          issuer={ownClient.issuer}
          busy={savingClient || waiting}
          onSave={(client) => void saveClient(client)}
          onCancel={() => setOwnClient(null)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {oauth?.needsAuth && !accounts.length && !waiting && (
          <span className="text-amber-300/90">{t('mcp.accounts.needsSignIn')}</span>
        )}
        {waiting ? (
          <>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('mcp.accounts.waiting')}
            </span>
            <button type="button" onClick={() => void actions.cancel(serverId)} className={linkCls}>
              {t('mcp.accounts.cancel')}
            </button>
          </>
        ) : (
          !ownClient && (
            <button
              type="button"
              onClick={() => void connect()}
              className="rounded border border-white/15 px-2 py-0.5 text-foreground hover:bg-white/[0.06]"
            >
              {accounts.length ? t('mcp.accounts.addAccount') : t('mcp.accounts.signIn')}
            </button>
          )
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
