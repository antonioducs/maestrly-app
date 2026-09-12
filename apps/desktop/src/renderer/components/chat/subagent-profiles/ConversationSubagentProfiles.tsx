import { useEffect, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { notifySubagentProfilesChanged } from '@/lib/subagent-catalog-events'
import type { ChatConfig } from '../../../../shared/chat'
import type {
  ConversationSubagentProfileConfigPayload,
  SubagentProfileCatalog,
} from '../../../../shared/subagent-profiles'
import { SubagentProfileRulesEditor } from './SubagentProfileRulesEditor'

export function ConversationSubagentProfiles({
  conversationId,
  returnFocusRef,
  onClose,
}: {
  conversationId: string
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useTranslation('chat')
  const [payload, setPayload] = useState<ConversationSubagentProfileConfigPayload | null>(null)
  const [catalog, setCatalog] = useState<SubagentProfileCatalog>({ agents: [], categories: [] })
  const [config, setConfig] = useState<ChatConfig | null>(null)

  useEffect(() => {
    let alive = true
    setPayload(null)
    void Promise.all([
      window.api.chatSubagentProfilesGetConversation(conversationId),
      window.api.chatSubagentProfilesCatalog(conversationId),
      window.api.chatConfig(),
    ]).then(([nextPayload, nextCatalog, nextConfig]) => {
      if (!alive) return
      setPayload(nextPayload)
      setCatalog(nextCatalog)
      setConfig(nextConfig)
    })
    return () => {
      alive = false
    }
  }, [conversationId])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-subagent-profiles-modal
        overlayClassName="z-[60] backdrop-blur-sm"
        className="inset-4 z-[60] m-auto h-fit max-h-[min(760px,calc(100vh-32px))] w-[calc(100vw-32px)] max-w-[720px] translate-none gap-0 overflow-auto rounded-xl border-border-strong bg-[#161618] p-4 shadow-2xl ring-1 ring-black/40"
        onEscapeKeyDown={(event) => {
          const searchSelect = (event.target as Element | null)?.closest('[data-search-select]')
          if (searchSelect?.querySelector('[aria-expanded="true"]')) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocusRef.current?.focus()
        }}
      >
        <div className="mb-3 pr-8">
          <DialogTitle className="text-[13px] font-semibold text-foreground">
            {t('subagentProfiles.conversationHeading')}
          </DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground">
            {payload?.enabled === false
              ? t('subagentProfiles.conversationDisabled')
              : payload?.rules
                ? t('subagentProfiles.conversationOverride')
                : t('subagentProfiles.conversationInherited')}
          </DialogDescription>
        </div>
        {payload && config && (
          <SubagentProfileRulesEditor
            value={payload.rules}
            catalog={catalog}
            config={config}
            diagnostics={payload.diagnostics}
            onSave={async (rules) => {
              const result = await window.api.chatSubagentProfilesSetConversation(conversationId, rules)
              if (!result.ok) return false
              setPayload(result.value)

              notifySubagentProfilesChanged()
              return true
            }}
            onClear={async () => {
              const result = await window.api.chatSubagentProfilesSetConversation(conversationId, null)
              if (result.ok) {
                setPayload(result.value)
                notifySubagentProfilesChanged()
              }
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
