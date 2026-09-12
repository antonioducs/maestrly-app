import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { notifySubagentProfilesChanged } from '@/lib/subagent-catalog-events'
import type { ChatConfig } from '../../../../shared/chat'
import type { SubagentProfileCatalog, SubagentProfileConfigPayload } from '../../../../shared/subagent-profiles'
import { SubagentProfileRulesEditor } from './SubagentProfileRulesEditor'

export function SubagentProfilesSettings({ config }: { config: ChatConfig }) {
  const { t } = useTranslation('chat')
  const [payload, setPayload] = useState<SubagentProfileConfigPayload | null>(null)
  const [catalog, setCatalog] = useState<SubagentProfileCatalog>({ agents: [], categories: [] })
  const refresh = () =>
    Promise.all([window.api.chatSubagentProfilesGetGlobal(), window.api.chatSubagentProfilesCatalog()]).then(
      ([nextPayload, nextCatalog]) => {
        setPayload(nextPayload)
        setCatalog(nextCatalog)
      }
    )
  useEffect(() => {
    void refresh()
  }, [])
  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-border pt-3">
      <div>
        <span className="text-[12px] font-medium text-foreground">{t('subagentProfiles.heading')}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t('subagentProfiles.description')}</p>
      </div>
      {payload && (
        <SubagentProfileRulesEditor
          value={payload.rules}
          catalog={catalog}
          config={config}
          diagnostics={payload.diagnostics}
          onSave={async (rules) => {
            const result = await window.api.chatSubagentProfilesSetGlobal(rules)
            if (!result.ok) return false
            setPayload(result.value)

            void refresh()
            notifySubagentProfilesChanged()
            return true
          }}
        />
      )}
    </div>
  )
}
