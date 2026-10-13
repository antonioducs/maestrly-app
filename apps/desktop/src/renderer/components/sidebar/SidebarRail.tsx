import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  AppWindow,
  BookOpen,
  Bot,
  CircleArrowUp,
  Clock,
  FlaskConical,
  FolderTree,
  HelpCircle,
  Info,
  LifeBuoy,
  MessagesSquare,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useHostApi } from '@/lib/hosts/host-context'
import { cn } from '@/lib/utils'
import { useSettings } from '@/lib/use-settings'
import { useOnboarding } from '@/lib/use-onboarding'
import { SUPPORT_LINKS } from '../../../shared/support'
import { useUnseenArtifactEvents } from '@/components/artifacts/use-artifact-activity'
import { QuickSubscriptionUsageDialog } from '@/components/chat/QuickSubscriptionUsageDialog'
import { connectedQuickUsageTargets, type QuickUsageTarget } from '@/components/chat/quick-subscription-usage'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { nextSidebarTab, sidebarTabs, type SidebarTab } from './sidebar-tabs'

const TAB_ICON: Record<SidebarTab, LucideIcon> = {
  chats: MessagesSquare,
  workspaces: FolderTree,
  bots: Bot,
}

type ShowTooltip = (e: { currentTarget: HTMLElement }, text: string, side?: 'below' | 'right') => void

const railButton =
  'no-drag relative grid place-items-center rounded-[10px] text-muted-foreground outline-none transition-colors hover:bg-white/[0.045] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/[0.045] data-[state=open]:text-foreground'

/**
 * The sidebar's icon rail: its sections as vertical tabs, each carrying its own marks (attention, experimental,
 * updates, pending requests), and below them what used to be the footer: Artifacts, Usage, Settings and Help.
 */
export function SidebarRail({
  tab,
  onTabChange,
  attention,
  botPendingCount,
  botUpdate = null,
  onOpenAbout,
  showQuickTooltip,
  hideQuickTooltip,
}: {
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  /** Sections where a conversation finished in the background and waits for the person, on any machine. */
  attention: Partial<Record<SidebarTab, boolean>>
  botPendingCount: number
  /** Bots can be updated, or an update of theirs runs or waits. */
  botUpdate?: 'available' | 'pending' | null
  onOpenAbout: () => void
  showQuickTooltip: ShowTooltip
  hideQuickTooltip: () => void
}) {
  const { t } = useTranslation('ui')
  const api = useHostApi()
  const { openSettings } = useSettings()
  const { openOnboarding } = useOnboarding()
  const unseenArtifactEvents = useUnseenArtifactEvents()
  const [usageOpen, setUsageOpen] = useState(false)
  const [usageTargets, setUsageTargets] = useState<QuickUsageTarget[]>([])
  const usageTargetsRequestRef = useRef(0)

  const refreshUsageTargets = useCallback(async () => {
    const request = ++usageTargetsRequestRef.current
    try {
      const config = await api.chatConfig()
      if (request === usageTargetsRequestRef.current) setUsageTargets(connectedQuickUsageTargets(config))
    } catch {}
  }, [api])

  useEffect(() => {
    void refreshUsageTargets()
    const offCodex = api.onChatSubscriptionStatus('codex-subscription', () => void refreshUsageTargets())
    const offClaude = api.onChatSubscriptionStatus('claude-subscription', () => void refreshUsageTargets())
    return () => {
      usageTargetsRequestRef.current += 1
      offCodex()
      offClaude()
    }
  }, [refreshUsageTargets, api])

  useEffect(() => {
    if (usageTargets.length === 0) setUsageOpen(false)
  }, [usageTargets.length])

  const tooltip = (text: string) => ({
    onMouseEnter: (e: { currentTarget: HTMLElement }) => showQuickTooltip(e, text, 'right'),
    onMouseLeave: hideQuickTooltip,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) showQuickTooltip(e, text, 'right')
    },
    onBlur: hideQuickTooltip,
  })

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextSidebarTab(tab, event.key)
    if (!next) return
    event.preventDefault()
    onTabChange(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#sidebar-tab-${next}`)?.focus()
  }

  const botUpdateLabel = botUpdate === 'pending' ? t('sidebar.botUpdatePending') : t('sidebar.botUpdate')

  return (
    <div className="flex w-12 shrink-0 flex-col items-center bg-black/[0.18] pb-2.5 pt-1 hairline-r">
      <div
        role="tablist"
        aria-label={t('sidebar.tabs')}
        aria-orientation="vertical"
        className="flex flex-col items-center gap-1"
      >
        {sidebarTabs.map((item) => {
          const Icon = TAB_ICON[item]
          const label = t(`sidebar.${item}`)
          const needsYou = item !== 'bots' && attention[item]
          let marks: ReactNode = null
          if (item === 'bots')
            marks = (
              <>
                {/* The rail is too narrow for a text badge: the flask marks the experimental section. */}
                <span
                  title={t('sidebar.experimental')}
                  className="absolute bottom-[3px] right-[3px] inline-flex text-amber-500"
                >
                  <FlaskConical aria-hidden="true" className="size-2.5" />
                  <span className="sr-only">{t('sidebar.experimental')}</span>
                </span>
                {botUpdate && (
                  <span className="absolute left-[3px] top-[3px] inline-flex text-primary">
                    {botUpdate === 'pending' ? (
                      <Clock aria-hidden="true" className="size-2.5" />
                    ) : (
                      <CircleArrowUp aria-hidden="true" className="size-2.5" />
                    )}
                    <span className="sr-only">{botUpdateLabel}</span>
                  </span>
                )}
                {botPendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[9.5px] font-bold leading-4 text-primary-foreground ring-2 ring-[#141416]">
                    {botPendingCount > 99 ? '99+' : botPendingCount}
                    <span className="sr-only"> {t('sidebar.pendingBots', { count: botPendingCount })}</span>
                  </span>
                )}
              </>
            )
          else if (needsYou)
            marks = (
              <span
                aria-hidden="true"
                className="absolute right-1.5 top-1.5 size-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] ring-2 ring-[#141416]"
              />
            )
          const tip =
            item === 'bots'
              ? [label, t('sidebar.experimental'), botUpdate ? botUpdateLabel : ''].filter(Boolean).join(' · ')
              : label
          return (
            <button
              key={item}
              type="button"
              role="tab"
              id={`sidebar-tab-${item}`}
              aria-controls={`sidebar-panel-${item}`}
              aria-selected={tab === item}
              aria-describedby={needsYou ? `sidebar-tab-${item}-attention` : undefined}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => onTabChange(item)}
              onKeyDown={handleTabKeyDown}
              {...tooltip(tip)}
              className={cn(
                railButton,
                'size-9',
                // The bar at the rail's edge marks the open section.
                'before:absolute before:-left-1.5 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r-[3px] before:bg-primary before:transition-opacity',
                tab === item ? 'bg-sidebar-accent text-foreground before:opacity-100' : 'before:opacity-0'
              )}
            >
              <Icon aria-hidden="true" className="size-[18px]" />
              <span className="sr-only">{label}</span>
              {marks}
            </button>
          )
        })}
      </div>
      {/* Described here, outside the tabs, so the tabs keep their plain names. */}
      {(['chats', 'workspaces'] as const).map(
        (item) =>
          attention[item] && (
            <span key={item} id={`sidebar-tab-${item}-attention`} className="sr-only">
              {t('sidebar.needsAttention')}
            </span>
          )
      )}

      <div className="min-h-0 flex-1" />

      <div className="flex flex-col items-center gap-0.5">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('maestrly:open-artifacts'))}
          aria-label={
            unseenArtifactEvents > 0
              ? `${t('artifacts.sidebar')}, ${t('artifacts.events.unseen', { count: unseenArtifactEvents })}`
              : t('artifacts.sidebar')
          }
          data-testid="sidebar-artifacts"
          {...tooltip(t('artifacts.sidebarTitle'))}
          className={cn(railButton, 'h-8 w-[34px]')}
        >
          <AppWindow aria-hidden="true" className="size-4" />
          {unseenArtifactEvents > 0 && (
            <span
              data-testid="sidebar-artifacts-unseen"
              aria-hidden="true"
              className="absolute -right-1 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[9.5px] font-bold leading-4 text-primary-foreground ring-2 ring-[#141416]"
            >
              {unseenArtifactEvents > 99 ? '99+' : unseenArtifactEvents}
            </span>
          )}
        </button>

        {usageTargets.length > 0 && (
          <button
            type="button"
            onClick={() => {
              hideQuickTooltip()
              setUsageOpen(true)
            }}
            aria-label={t('sidebar.usage')}
            data-testid="sidebar-usage"
            {...tooltip(t('sidebar.usageTitle'))}
            className={cn(railButton, 'h-8 w-[34px]')}
          >
            <Activity aria-hidden="true" className="size-4" />
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            hideQuickTooltip()
            openSettings()
          }}
          aria-label={t('sidebar.settings')}
          {...tooltip(t('sidebar.settingsTitle'))}
          className={cn(railButton, 'h-8 w-[34px]')}
        >
          <Settings aria-hidden="true" className="size-4" />
        </button>

        <DropdownMenu onOpenChange={(open) => open && hideQuickTooltip()}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('sidebar.help')}
              {...tooltip(t('sidebar.help'))}
              className={cn(railButton, 'h-8 w-[34px]')}
            >
              <HelpCircle aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" sideOffset={8} className="min-w-[200px]">
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
      </div>

      <QuickSubscriptionUsageDialog open={usageOpen} onOpenChange={setUsageOpen} targets={usageTargets} />
    </div>
  )
}
