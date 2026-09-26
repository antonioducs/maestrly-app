import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetLoginKind, FleetLoginStartRequest } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { accountHost, type BotProvisioning } from '@/lib/fleet/provisioning'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { MacImportDialog } from './MacImportDialog'
import { BotLoginDialog } from './BotLoginDialog'

const groups = ['accounts'] as Array<'accounts'>
export function BotAccountsSection({
  bot,
  lists,
  availability,
  children,
  onChanged,
}: {
  bot: FleetBot
  lists: BotProvisioning
  availability: 'ready' | 'update-server' | 'restart-bot'
  children: ReactNode
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation('fleet')
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
    <section className="space-y-3" aria-label={t('botAccounts.title')}>
      <h2 className="font-semibold">{t('botAccounts.title')}</h2>
      {availability !== 'ready' ? (
        <p className="text-xs text-muted-foreground">
          {t(availability === 'update-server' ? 'provisioning.updateServer' : 'provisioning.restartBot')}
        </p>
      ) : (
        <>
          {lists.accounts && !lists.accounts.apiKeys.length && !lists.accounts.subscriptions.length && (
            <p className="text-xs text-muted-foreground">{t('botAccounts.empty')}</p>
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
                      remove: () => window.api.fleetRemoveAccount(bot.id, item.providerId),
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
                  (item.kind === 'codex' || item.kind === 'claude' || item.kind === 'grok') && (
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
                        window.api.fleetRemoveBotSubscription(bot.id, item.kind, item.accountId ?? 'default'),
                    })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={bot.lifecycle !== 'running'}
              onClick={() => setImporting(true)}
            >
              {t('provisioning.fromMacButton')}
            </Button>
            {(['codex', 'claude', 'grok'] as const).map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="outline"
                disabled={bot.lifecycle !== 'running'}
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
          bot={bot}
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
          bot={bot}
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
          message={t('botAccounts.removeConfirm', { name: confirm.name })}
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
