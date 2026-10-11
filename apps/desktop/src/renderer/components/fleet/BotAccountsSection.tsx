import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetLoginKind, FleetLoginStartRequest } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { accountHost, type BotProvisioning } from '@/lib/fleet/provisioning'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { isEnvironmentTarget, provisioningHintKey, type ProvisioningSubject } from '@/lib/fleet/environments'
import { MacImportDialog } from './MacImportDialog'
import { BotLoginDialog } from './BotLoginDialog'

const groups = ['accounts'] as Array<'accounts'>
/** The accounts of an environment (shared by its bots) or, before environments, of a bot. */
export function BotAccountsSection({
  subject,
  lists,
  availability,
  children,
  onChanged,
}: {
  subject: ProvisioningSubject
  lists: BotProvisioning
  availability: 'ready' | 'update-server' | 'restart-bot' | 'restart-environment'
  children: ReactNode
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation('fleet')
  const shared = isEnvironmentTarget(subject.target)
  const [importing, setImporting] = useState(false)
  const [login, setLogin] = useState<{ kind: FleetLoginKind; slot: FleetLoginStartRequest['slot'] } | null>(null)
  const [confirm, setConfirm] = useState<{ name: string; remove: () => Promise<void> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function changed() {
    lists.refresh()
    try {
      await onChanged()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }
  async function remove() {
    if (!confirm || busy) return
    setBusy(true)
    setError('')
    try {
      await confirm.remove()
      setConfirm(null)
      await changed()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3" aria-label={shared ? t('environment.accounts') : t('botAccounts.title')}>
      <h2 className="font-semibold">{shared ? t('environment.accounts') : t('botAccounts.title')}</h2>
      {availability !== 'ready' ? (
        <p className="text-xs text-muted-foreground">{t(provisioningHintKey(availability))}</p>
      ) : (
        <>
          {lists.accounts && !lists.accounts.apiKeys.length && !lists.accounts.subscriptions.length && (
            <p className="text-xs text-muted-foreground">
              {shared ? t('environment.accountsEmpty') : t('botAccounts.empty')}
            </p>
          )}
          <ul className="space-y-2">
            {lists.accounts?.apiKeys.map((item) => (
              <li
                key={item.providerId}
                className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span>
                  {t('botAccounts.apiKey', {
                    name: item.name,
                    host: accountHost(item.kind, item.baseURL),
                    hint: item.keyHint ?? '',
                  })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setConfirm({
                      name: item.name,
                      remove: () => window.api.fleetRemoveAccount(subject.target, item.providerId),
                    })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
            {lists.accounts?.subscriptions.map((item) => (
              <li
                key={`${item.kind}:${item.accountId}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span className="flex-1">
                  {[item.label, item.email, item.plan, t(`botAccounts.state.${item.state}`)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {item.state === 'signed-out' &&
                  (item.kind === 'codex' ||
                    item.kind === 'claude' ||
                    item.kind === 'grok' ||
                    item.kind === 'antigravity') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setLogin({ kind: item.kind as FleetLoginKind, slot: item.accountId ?? 'default' })}
                    >
                      {t('botAccounts.reconnect')}
                    </Button>
                  )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setConfirm({
                      name: item.label,
                      remove: () =>
                        window.api.fleetRemoveBotSubscription(subject.target, item.kind, item.accountId ?? 'default'),
                    })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!subject.running} onClick={() => setImporting(true)}>
              {t('provisioning.fromMacButton')}
            </Button>
            {(['codex', 'claude', 'grok', 'antigravity'] as const).map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                disabled={!subject.running}
                onClick={() => setLogin({ kind, slot: 'auto' })}
              >
                {t('login.signInWith', { provider: t(`login.provider.${kind}`) })}
              </Button>
            ))}
          </div>
        </>
      )}
      {children}
      {(error || lists.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || lists.error}
        </p>
      )}
      {importing && (
        <MacImportDialog
          subject={subject}
          lists={lists}
          groups={groups}
          onClose={() => {
            setImporting(false)
            void changed()
          }}
        />
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
      {confirm && (
        <ConfirmDialog
          title={t('botSettings.removeAccountTitle')}
          message={
            shared
              ? t('environment.removeConfirm', { name: confirm.name })
              : t('botAccounts.removeConfirm', { name: confirm.name })
          }
          confirmLabel={t('botAccounts.remove')}
          destructive
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  )
}
