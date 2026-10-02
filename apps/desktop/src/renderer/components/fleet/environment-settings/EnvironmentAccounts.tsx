import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetLoginKind, FleetLoginStartRequest, FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import { requestMainNavigation } from '@/lib/main-navigation'
import { accountReplacementFields } from '@/lib/fleet/environment-settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  useEnvironmentSettingsResource,
  useEnvironmentSettingsSource,
  useSettingsLifetime,
} from '@/lib/fleet/environment-settings'
import { useFleetProvisioning } from '@/lib/fleet/provisioning'
import { ApiKeyAccountForm } from '../ApiKeyAccountForm'
import { BotLoginDialog } from '../BotLoginDialog'
import { MacImportDialog } from '../MacImportDialog'
import {
  SaveDiscard,
  SettingsPanel,
  settingsInput,
  Usage,
  useSettingsDraft,
  type EnvironmentSettingsSectionProps,
} from './shared'
type Accounts = FleetSettingsOutput<'accounts'>
type Selection = { api: Accounts['apiKeys'][number] } | { subscription: Accounts['subscriptions'][number] }
export function EnvironmentAccounts(props: EnvironmentSettingsSectionProps) {
  return <AccountsPanel key={props.environment.id} {...props} />
}
function AccountsPanel({ environment, fleet, onDirtyChange }: EnvironmentSettingsSectionProps) {
  const { t } = useTranslation('fleet')
  const resource = useEnvironmentSettingsResource(environment.id, 'accounts')
  const lists = useFleetProvisioning({ environmentId: environment.id })
  const [editing, setEditing] = useState<Selection | null>(null)
  const [removing, setRemoving] = useState<Selection | null>(null)
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [adding, setAdding] = useState(false)
  const [login, setLogin] = useState<{ kind: FleetLoginKind; slot: FleetLoginStartRequest['slot'] } | null>(null)
  const online = fleet.state.connection.state === 'connected' && environment.lifecycle === 'running'
  const lifetime = useSettingsLifetime()
  const subject = {
    target: { environmentId: environment.id },
    name: environment.name,
    running: environment.lifecycle === 'running',
  }
  async function changed() {
    lists.refresh()
    await Promise.all([resource.reload(), fleet.refresh()])
  }
  async function remove() {
    if (!online || !removing || !resource.data || busy) return
    const epoch = lifetime.current
    setBusy(true)
    try {
      if ('api' in removing)
        await resource.source.removeAccount({
          providerId: removing.api.providerId,
          expectedRevision: resource.data.revision,
        })
      else
        await resource.source.removeSubscription({
          kind: removing.subscription.kind,
          slot: removing.subscription.accountId,
          expectedRevision: resource.data.revision,
        })
      if (epoch !== lifetime.current) return
      setRemoving(null)
      await changed()
    } catch {
      if (epoch === lifetime.current) resource.setError(true)
    } finally {
      if (epoch === lifetime.current) setBusy(false)
    }
  }
  return (
    <SettingsPanel
      error={resource.error}
      reload={() => {
        setEditing(null)
        onDirtyChange?.(
          false,
          async () => true,
          () => {}
        )
        void resource.reload()
      }}
      loading={!resource.data && resource.busy}
    >
      <p className="text-xs text-muted-foreground">{t('environmentSettings.accountsNote')}</p>
      <h3 className="text-xs font-medium">{t('environmentSettings.subscriptions')}</h3>
      {resource.data?.subscriptions.map((account) => (
        <div
          key={`${account.kind}:${account.accountId}`}
          className="rounded-lg border border-border bg-white/[0.025] px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${account.state === 'connected' ? 'bg-emerald-400' : 'bg-muted-foreground'}`}
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2">
                {account.label}
                <span
                  className={`text-[11px] ${account.state === 'connected' ? 'text-emerald-400' : 'text-muted-foreground'}`}
                >
                  {t(`botAccounts.state.${account.state}`)}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {account.email} · {account.plan}
              </p>
              <Usage bots={account.bots} />
            </div>
            {account.state === 'signed-out' &&
              (['codex', 'claude', 'grok', 'antigravity'] as string[]).includes(account.kind) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!editing || adding}
                  onClick={() =>
                    setLogin({ kind: account.kind as FleetLoginKind, slot: account.accountId ?? 'default' })
                  }
                >
                  {t('botAccounts.reconnect')}
                </Button>
              )}
            <Button
              size="sm"
              variant="ghost"
              disabled={!!editing || adding}
              onClick={() => setEditing({ subscription: account })}
            >
              {t('environmentSettings.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!editing || adding}
              onClick={() => setRemoving({ subscription: account })}
            >
              {t('environmentSettings.remove')}
            </Button>
          </div>
        </div>
      ))}
      <h3 className="text-xs font-medium">{t('environmentSettings.apiKeys')}</h3>
      {resource.data?.apiKeys.map((account) => (
        <div key={account.providerId} className="rounded-lg border border-border bg-white/[0.025] px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p>{account.name}</p>
              <p className="text-xs text-muted-foreground">
                {account.kind} · {account.keyHint}
              </p>
              <Usage bots={account.bots} />
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!editing || adding}
              onClick={() => setEditing({ api: account })}
            >
              {t('environmentSettings.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!editing || adding}
              onClick={() => setRemoving({ api: account })}
            >
              {t('environmentSettings.remove')}
            </Button>
          </div>
        </div>
      ))}
      {editing && resource.data && (
        <AccountEditor
          selection={
            'api' in editing
              ? { api: resource.data.apiKeys.find((a) => a.providerId === editing.api.providerId) ?? editing.api }
              : {
                  subscription:
                    resource.data.subscriptions.find(
                      (a) => a.kind === editing.subscription.kind && a.accountId === editing.subscription.accountId
                    ) ?? editing.subscription,
                }
          }
          revision={resource.data.revision}
          online={online}
          environmentId={environment.id}
          onDirtyChange={onDirtyChange}
          onDone={() => {
            setEditing(null)
            void changed()
          }}
        />
      )}
      {!editing && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => requestMainNavigation(() => setAdding(!adding))}>
              {t('botSettings.addApiKey')}
            </Button>
            <Button size="sm" variant="outline" disabled={adding} onClick={() => setImporting(true)}>
              {t('provisioning.fromMacButton')}
            </Button>
            {(['codex', 'claude', 'grok', 'antigravity'] as const).map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                disabled={adding}
                onClick={() => setLogin({ kind, slot: 'auto' })}
              >
                {t('login.signInWith', { provider: t(`login.provider.${kind}`) })}
              </Button>
            ))}
          </div>
          {adding && <ApiKeyAccountForm {...{ onDirtyChange }} target={subject.target} onAdded={changed} />}
        </>
      )}
      {login && (
        <BotLoginDialog
          subject={subject}
          {...login}
          open
          onClose={() => {
            setLogin(null)
            void changed()
          }}
        />
      )}
      {importing && (
        <MacImportDialog
          subject={subject}
          lists={lists}
          groups={['accounts']}
          onClose={() => {
            setImporting(false)
            void changed()
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t('environmentSettings.remove')}
          message={t('environmentSettings.removeUsed', {
            names:
              ('api' in removing ? removing.api.bots : removing.subscription.bots).map((b) => b.name).join(', ') ||
              t('environmentSettings.none'),
          })}
          confirmLabel={t('environmentSettings.remove')}
          destructive
          busy={busy}
          error={resource.error ? t('environmentSettings.failed') : null}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove()}
        />
      )}
    </SettingsPanel>
  )
}
function AccountEditor({
  selection,
  revision,
  environmentId,
  onDone,
  online,
  onDirtyChange,
}: {
  selection: Selection
  revision: string
  environmentId: string
  online: boolean
  onDone: () => void
  onDirtyChange: EnvironmentSettingsSectionProps['onDirtyChange']
}) {
  const { t } = useTranslation('fleet')
  const source = useEnvironmentSettingsSource(environmentId)
  const account = 'api' in selection ? selection.api : null
  const currentRevision = useRef(revision)
  const editor = useSettingsDraft(
    {
      name: account?.name ?? ('subscription' in selection ? selection.subscription.label : ''),
      baseURL: '',
      apiKey: '',
    },
    async (draft) => {
      if (!online) throw new Error('Environment offline')
      if (account)
        currentRevision.current = (
          await source.patchAccount({
            providerId: account.providerId,
            expectedRevision: currentRevision.current,
            name: draft.name,
            ...accountReplacementFields(draft),
          })
        ).revision
      else if ('subscription' in selection)
        currentRevision.current = (
          await source.renameSubscription({
            kind: selection.subscription.kind,
            slot: selection.subscription.accountId,
            expectedRevision: currentRevision.current,
            label: draft.name,
          })
        ).revision
    },
    onDirtyChange,
    revision
  )
  useEffect(() => {
    if (!editor.dirty) currentRevision.current = revision
  }, [revision])
  const save = async () => {
    const ok = await editor.save()
    if (ok) {
      onDirtyChange?.(
        false,
        async () => true,
        () => {}
      )
      onDone()
    }
    return ok
  }
  const discard = () => {
    editor.discard()
    onDirtyChange?.(
      false,
      async () => true,
      () => {}
    )
    onDone()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !editor.busy) requestMainNavigation(discard)
      }}
    >
      <DialogContent className="max-h-[85vh] w-[calc(100%-2rem)] overflow-y-auto rounded-xl">
        <DialogHeader>
          <DialogTitle>{t('environmentSettings.editAccount')}</DialogTitle>
          <DialogDescription>{t('environmentSettings.preserveSecret')}</DialogDescription>
        </DialogHeader>
        <SettingsPanel error={editor.error} reload={discard}>
          <label className="block space-y-1">
            {t('environmentSettings.name')}
            <input
              className={settingsInput}
              value={editor.draft.name}
              disabled={editor.busy || !online}
              onChange={(e) => editor.setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </label>
          {account && (
            <>
              <label className="block space-y-1">
                {t('environmentSettings.baseURL')}
                <input
                  className={settingsInput}
                  placeholder={account.baseURL ?? undefined}
                  value={editor.draft.baseURL}
                  disabled={editor.busy || !online}
                  onChange={(e) => editor.setDraft((d) => ({ ...d, baseURL: e.target.value }))}
                />
              </label>
              <label className="block space-y-1">
                {t('environmentSettings.replaceKey')}
                <input
                  type="password"
                  autoComplete="new-password"
                  className={settingsInput}
                  value={editor.draft.apiKey}
                  disabled={editor.busy || !online}
                  onChange={(e) => editor.setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                />
              </label>
            </>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <SaveDiscard {...editor} busy={editor.busy || !online} save={save} discard={discard} />
            <Button size="sm" variant="ghost" disabled={editor.busy} onClick={() => requestMainNavigation(discard)}>
              {t('environmentSettings.close')}
            </Button>
          </div>
        </SettingsPanel>
      </DialogContent>
    </Dialog>
  )
}
