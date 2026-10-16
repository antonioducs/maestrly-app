import { useEffect, useState } from 'react'
import { useHostApi } from '@/lib/hosts/host-context'
import { notifySubagentProfilesChanged } from '@/lib/subagent-catalog-events'
import type { ChatConfig } from '../../../../shared/chat'
import type {
  SubagentProfileCatalog,
  SubagentProfileConfigPayload,
  SubagentProfileRulesV1,
} from '../../../../shared/subagent-profiles'
import { SubagentProfileRulesEditor } from './SubagentProfileRulesEditor'

export function SubagentProfilesSettings({
  config,
  onRulesChange,
}: {
  config: ChatConfig
  /** The saved global rules, for the models-in-use summary. */
  onRulesChange?: (rules: SubagentProfileRulesV1 | null) => void
}) {
  const api = useHostApi()
  const [payload, setPayload] = useState<SubagentProfileConfigPayload | null>(null)
  const [catalog, setCatalog] = useState<SubagentProfileCatalog>({ agents: [], categories: [] })
  const refresh = () =>
    Promise.all([api.chatSubagentProfilesGetGlobal(), api.chatSubagentProfilesCatalog()]).then(
      ([nextPayload, nextCatalog]) => {
        setPayload(nextPayload)
        setCatalog(nextCatalog)
      }
    )
  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    if (payload) onRulesChange?.(payload.rules)
  }, [payload, onRulesChange])
  if (!payload) return null
  return (
    <SubagentProfileRulesEditor
      value={payload.rules}
      catalog={catalog}
      config={config}
      diagnostics={payload.diagnostics}
      onSave={async (rules) => {
        const result = await api.chatSubagentProfilesSetGlobal(rules)
        if (!result.ok) return false
        setPayload(result.value)

        void refresh()
        notifySubagentProfilesChanged()
        return true
      }}
    />
  )
}
