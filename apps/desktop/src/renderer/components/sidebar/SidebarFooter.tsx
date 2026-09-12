import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Archive, Settings, HelpCircle, Info, Sparkles, BookOpen, LifeBuoy } from 'lucide-react'
import type { WorkspaceWithConversations } from '../../../preload'
import { cn } from '@/lib/utils'
import { useSettings } from '@/lib/use-settings'
import { useOnboarding } from '@/lib/use-onboarding'
import { SUPPORT_LINKS } from '../../../shared/support'
import { QuickSubscriptionUsageDialog } from '@/components/chat/QuickSubscriptionUsageDialog'
import { connectedQuickUsageTargets, type QuickUsageTarget } from '@/components/chat/quick-subscription-usage'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

export function SidebarFooter({
  workspaces,
  showArchived,
  onToggleArchived,
  onOpenAbout,
}: {
  workspaces: WorkspaceWithConversations[]
  showArchived: boolean
  onToggleArchived: () => void
  onOpenAbout: () => void
}) {
  const { t } = useTranslation('ui')

  const { openSettings } = useSettings()

  const { openOnboarding } = useOnboarding()
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageTargets, setUsageTargets] = useState<QuickUsageTarget[]>([])
  const usageTargetsRequestRef = useRef(0)

  const refreshUsageTargets = useCallback(async () => {
    const request = ++usageTargetsRequestRef.current
    try {
      const config = await window.api.chatConfig()
      if (request === usageTargetsRequestRef.current) setUsageTargets(connectedQuickUsageTargets(config))
    } catch {}
  }, [])

  useEffect(() => {
    void refreshUsageTargets()
    const offCodex = window.api.onChatSubscriptionStatus('codex-subscription', () => void refreshUsageTargets())
    const offClaude = window.api.onChatSubscriptionStatus('claude-subscription', () => void refreshUsageTargets())
    return () => {
      usageTargetsRequestRef.current += 1
      offCodex()
      offClaude()
    }
  }, [refreshUsageTargets])

  useEffect(() => {
    if (usageTargets.length === 0) setUsageOpen(false)
  }, [usageTargets.length])

  return (
    <>
      {(() => {
        const archivedTotal = workspaces.reduce((n, w) => n + (w.archivedCount ?? 0), 0)
        if (archivedTotal === 0 && !showArchived) return null
        return (
          <button
            onClick={onToggleArchived}
            className={cn(
              'no-drag flex shrink-0 items-center gap-2 hairline-t px-3 py-2 text-xs transition-colors hover:bg-white/[0.04]',
              showArchived ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            <Archive className="size-3.5" />
            {showArchived ? t('sidebar.hideArchived') : t('sidebar.showArchived', { count: archivedTotal })}
          </button>
        )
      })()}

      {usageTargets.length > 0 && (
        <button
          onClick={() => setUsageOpen(true)}
          className="no-drag flex shrink-0 items-center gap-2 hairline-t px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
          title={t('sidebar.usageTitle')}
          data-testid="sidebar-usage"
        >
          <Activity className="size-3.5 shrink-0" />
          <span className="truncate">{t('sidebar.usage')}</span>
        </button>
      )}

      <button
        onClick={openSettings}
        className="no-drag flex shrink-0 items-center gap-2 hairline-t px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
        title={t('sidebar.settingsTitle')}
      >
        <Settings className="size-3.5 shrink-0" />
        <span className="truncate">{t('sidebar.settings')}</span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="no-drag flex shrink-0 items-center gap-2 hairline-t px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground data-[state=open]:text-foreground"
            title={t('sidebar.help')}
          >
            <HelpCircle className="size-3.5 shrink-0" />
            <span className="truncate">{t('sidebar.help')}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
          <DropdownMenuItem
            onClick={() => void window.api.openExternalUrl(SUPPORT_LINKS.docs)}
            className="gap-2 text-xs"
          >
            <BookOpen className="size-3.5" /> {t('sidebar.docs')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void window.api.openExternalUrl(SUPPORT_LINKS.support)}
            className="gap-2 text-xs"
          >
            <LifeBuoy className="size-3.5" /> {t('sidebar.support')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={openOnboarding} className="gap-2 text-xs">
            <Sparkles className="size-3.5" /> {t('sidebar.welcomeTour')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenAbout} className="gap-2 text-xs">
            <Info className="size-3.5" /> {t('sidebar.about')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <QuickSubscriptionUsageDialog open={usageOpen} onOpenChange={setUsageOpen} targets={usageTargets} />
    </>
  )
}
