import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isEnvironmentTarget, provisioningHintKey, type ProvisioningSubject } from '@/lib/fleet/environments'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { BotProvisioning, ImportGroup } from '@/lib/fleet/provisioning'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { MacImportDialog } from './MacImportDialog'

const groups: ImportGroup[] = ['skills', 'mcp']
/** The skills and MCP servers of an environment (shared by its bots) or, before environments, of a bot. */
export function BotSkillsMcpSection({
  subject,
  lists,
  availability,
}: {
  subject: ProvisioningSubject
  lists: BotProvisioning
  availability: 'ready' | 'update-server' | 'restart-bot' | 'restart-environment'
}) {
  const { t } = useTranslation('fleet')
  const shared = isEnvironmentTarget(subject.target)
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
        <p className="text-xs text-muted-foreground">{t(provisioningHintKey(availability))}</p>
      ) : (
        <>
          <h3 className="text-sm font-medium">{t('provisioning.groups.skills')}</h3>
          {lists.skills?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {shared ? t('environment.emptySkills') : t('botSkillsMcp.emptySkills')}
            </p>
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
                    setConfirm({
                      name: item.name,
                      remove: () => window.api.fleetRemoveBotSkill(subject.target, item.name),
                    })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
          <h3 className="text-sm font-medium">{t('provisioning.groups.mcp')}</h3>
          {lists.mcpServers?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {shared ? t('environment.emptyMcp') : t('botSkillsMcp.emptyMcp')}
            </p>
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
                    setConfirm({
                      name: item.name,
                      remove: () => window.api.fleetRemoveBotMcpServer(subject.target, item.id),
                    })
                  }
                >
                  {t('botAccounts.remove')}
                </Button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" disabled={!subject.running} onClick={() => setImporting(true)}>
            {t('provisioning.fromMacButton')}
          </Button>
        </>
      )}
      {(error || lists.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || lists.error}
        </p>
      )}
      {importing && (
        <MacImportDialog subject={subject} groups={groups} lists={lists} onClose={() => setImporting(false)} />
      )}
      {confirm && (
        <ConfirmDialog
          title={
            shared
              ? t('environment.removeConfirm', { name: confirm.name })
              : t('botAccounts.removeConfirm', { name: confirm.name })
          }
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
