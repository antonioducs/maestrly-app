import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { BotProvisioning, ImportGroup } from '@/lib/fleet/provisioning'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { MacImportDialog } from './MacImportDialog'

const groups: ImportGroup[] = ['skills', 'mcp']
export function BotSkillsMcpSection({
  bot,
  lists,
  availability,
}: {
  bot: FleetBot
  lists: BotProvisioning
  availability: 'ready' | 'update-server' | 'restart-bot'
}) {
  const { t } = useTranslation('fleet')
  const [importing, setImporting] = useState(false)
  const [confirm, setConfirm] = useState<{ name: string; remove: () => Promise<void> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    if (!confirm || busy) return
    setBusy(true)
    setError('')
    try {
      await confirm.remove()
      setConfirm(null)
      lists.refresh()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3" aria-label={t('botSkillsMcp.title')}>
      <h2 className="font-semibold">{t('botSkillsMcp.title')}</h2>
      {availability !== 'ready' ? (
        <p className="text-xs text-muted-foreground">
          {t(availability === 'update-server' ? 'provisioning.updateServer' : 'provisioning.restartBot')}
        </p>
      ) : (
        <>
          <h3 className="text-sm font-medium">{t('provisioning.groups.skills')}</h3>
          {lists.skills?.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('botSkillsMcp.emptySkills')}</p>
          )}
          <ul className="space-y-2">
            {lists.skills?.map((item) => (
              <li key={item.name} className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                <div className="flex-1">
                  <strong>{item.name}</strong>
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('provisioning.files', { count: item.files })} · {t(`botSkillsMcp.source.${item.source}`)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setConfirm({ name: item.name, remove: () => window.api.fleetRemoveBotSkill(bot.id, item.name) })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
          <h3 className="text-sm font-medium">{t('provisioning.groups.mcp')}</h3>
          {lists.mcpServers?.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('botSkillsMcp.emptyMcp')}</p>
          )}
          <ul className="space-y-2">
            {lists.mcpServers?.map((item) => (
              <li key={item.id} className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                <div className="flex-1">
                  <strong>{item.name}</strong>
                  <p className="text-xs text-muted-foreground">{item.command ?? item.host}</p>
                  {item.unavailable && <p className="text-xs text-muted-foreground">{t('botSkillsMcp.unavailable')}</p>}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setConfirm({ name: item.name, remove: () => window.api.fleetRemoveBotMcpServer(bot.id, item.id) })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" disabled={bot.lifecycle !== 'running'} onClick={() => setImporting(true)}>
            {t('provisioning.fromMacButton')}
          </Button>
        </>
      )}
      {(error || lists.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || lists.error}
        </p>
      )}
      {importing && <MacImportDialog bot={bot} groups={groups} lists={lists} onClose={() => setImporting(false)} />}
      {confirm && (
        <ConfirmDialog
          title={t('botAccounts.removeConfirm', { name: confirm.name })}
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
