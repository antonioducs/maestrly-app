import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, FolderPlus, Search, PanelLeft, Layers, Plus } from 'lucide-react'
import { instanceBadgeStyle } from '../../../shared/instance-color'
import type { AppInfo } from '../../../preload'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { nextSidebarTab, sidebarTabs, type SidebarTab } from './sidebar-tabs'

export function SidebarHeader({
  query,
  onQueryChange,
  onCollapseSidebar,
  onOpenAbout,
  onNewGroup,
  onAddWorkspace,
  tab,
  onTabChange,
  onNewChat,
  creatingChat,
  botServerConnected,
  botPendingCount,
  onCreateBot,
}: {
  query: string
  onQueryChange: (value: string) => void
  onCollapseSidebar: () => void
  onOpenAbout: () => void
  onNewGroup: () => Promise<void>
  onAddWorkspace: () => void
  tab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  onNewChat: () => Promise<void>
  creatingChat: boolean
  botServerConnected: boolean
  botPendingCount: number
  onCreateBot?: () => void
}) {
  const { t } = useTranslation('ui')

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    window.api
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => {})
  }, [])
  const channelBadge =
    appInfo && !appInfo.hideChannelBadge && appInfo.channel !== 'prod'
      ? appInfo.instanceId
        ? `${appInfo.channel.toUpperCase()} · ${appInfo.instanceId}`
        : appInfo.channel.toUpperCase()
      : null
  const instanceBadgeColors = useMemo((): CSSProperties | undefined => {
    if (appInfo?.channel === 'dev' && appInfo.instanceId) {
      return instanceBadgeStyle(appInfo.instanceId)
    }
    return undefined
  }, [appInfo?.channel, appInfo?.instanceId])

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextSidebarTab(tab, event.key)
    if (!next) return
    event.preventDefault()
    onTabChange(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#sidebar-tab-${next}`)?.focus()
  }

  return (
    <>
      <div className="drag flex h-10 shrink-0 items-center pl-[var(--tt-offset)] pr-2">
        <Button
          variant="ghost"
          size="icon"
          className="no-drag size-7 text-muted-foreground"
          onClick={onCollapseSidebar}
          title={t('sidebar.collapsePanel')}
        >
          <PanelLeft className="size-4" />
        </Button>

        {channelBadge && (
          <button
            type="button"
            onClick={onOpenAbout}
            className={cn(
              'no-drag ml-auto cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] transition-opacity hover:opacity-80',
              !instanceBadgeColors &&
                (appInfo?.channel === 'dev'
                  ? 'border-emerald-400/40 bg-emerald-400/15 text-emerald-300'
                  : 'border-amber-400/40 bg-amber-400/15 text-amber-300')
            )}
            style={instanceBadgeColors}
            title={t('sidebar.channelTitle', {
              channel: appInfo?.channel,
              instance: appInfo?.instanceId ? ` \u00b7 ${appInfo.instanceId}` : '',
              version: appInfo?.version,
            })}
          >
            {channelBadge}
          </button>
        )}
      </div>

      <div className="drag flex h-9 shrink-0 items-stretch gap-1.5 hairline-b px-2">
        <div role="tablist" aria-label={t('sidebar.tabs')} className="no-drag flex min-w-0 items-stretch gap-2">
          {sidebarTabs.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`sidebar-tab-${item}`}
              aria-controls={`sidebar-panel-${item}`}
              aria-selected={tab === item}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => onTabChange(item)}
              onKeyDown={handleTabKeyDown}
              className={cn(
                'relative inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-foreground',
                'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t after:bg-primary after:content-[" "]',
                tab === item ? 'text-foreground after:opacity-100' : 'after:opacity-0'
              )}
            >
              {t(`sidebar.${item}`)}
              {item === 'bots' && (
                // The sidebar is too narrow for a text badge next to the three tabs.
                <span title={t('sidebar.experimental')} className="inline-flex text-amber-500">
                  <FlaskConical aria-hidden="true" className="size-3" />
                  <span className="sr-only">{t('sidebar.experimental')}</span>
                </span>
              )}
              {item === 'bots' && botPendingCount > 0 && (
                <span className="rounded-full bg-primary/15 px-1 text-[10px] tracking-normal text-primary">
                  {botPendingCount}
                  <span className="sr-only"> {t('sidebar.pendingBots', { count: botPendingCount })}</span>
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="no-drag ml-auto flex shrink-0 items-center gap-0.5">
          {tab === 'chats' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              disabled={creatingChat}
              onClick={() => void onNewChat()}
              title={t('sidebar.newChat')}
              aria-label={t('sidebar.newChat')}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
          {tab === 'workspaces' && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => void onNewGroup()}
                title={t('sidebar.newGroup')}
                aria-label={t('sidebar.newGroup')}
              >
                <Layers className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={onAddWorkspace}
                title={t('sidebar.addWorkspace')}
                aria-label={t('sidebar.addWorkspace')}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </>
          )}
          {tab === 'bots' && (
            <span title={botServerConnected ? t('sidebar.createBot') : t('sidebar.noServerConnected')}>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={!botServerConnected || !onCreateBot}
                onClick={onCreateBot}
                aria-label={t('sidebar.createBot')}
              >
                <Plus className="size-3.5" />
              </Button>
            </span>
          )}
        </div>
      </div>

      {/* Conversation search */}
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-input px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t(
              tab === 'chats'
                ? 'sidebar.filterChats'
                : tab === 'bots'
                  ? 'sidebar.filterBots'
                  : 'sidebar.filterPlaceholder'
            )}
            aria-label={t(
              tab === 'chats'
                ? 'sidebar.filterChats'
                : tab === 'bots'
                  ? 'sidebar.filterBots'
                  : 'sidebar.filterPlaceholder'
            )}
            className="h-6 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </>
  )
}
