import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Loader2, MoreHorizontal, PanelLeft, Plus, Search, X } from 'lucide-react'
import { instanceBadgeStyle } from '../../../shared/instance-color'
import type { AppInfo } from '../../../preload'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { SidebarTab } from './sidebar-tabs'

/** The window's title bar over the sidebar: room for the traffic lights, collapse, and the channel badge. */
export function SidebarTitleBar({
  onCollapseSidebar,
  onOpenAbout,
}: {
  onCollapseSidebar: () => void
  onOpenAbout: () => void
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

  return (
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
            instance: appInfo?.instanceId ? ` · ${appInfo.instanceId}` : '',
            version: appInfo?.version,
          })}
        >
          {channelBadge}
        </button>
      )}
    </div>
  )
}

/** The one thing a section creates, on the machine the sidebar shows. */
export interface SidebarCreateAction {
  label: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  /** Why it is disabled, shown on hover. */
  disabledReason?: string
}

/**
 * The top of the list panel: the open section's name, its one create button and its view options, then what the
 * sidebar shows between them and the search (the host switcher), then the search.
 */
export function SidebarPanelHeader({
  tab,
  create,
  viewMenu,
  children,
  query,
  onQueryChange,
}: {
  tab: SidebarTab
  create: SidebarCreateAction | null
  /** The items of the `⋯` menu; no menu without them. */
  viewMenu: ReactNode | null
  children?: ReactNode
  query: string
  onQueryChange: (value: string) => void
}) {
  const { t } = useTranslation('ui')
  const filterLabel = t(
    tab === 'chats' ? 'sidebar.filterChats' : tab === 'bots' ? 'sidebar.filterBots' : 'sidebar.filterPlaceholder'
  )
  const createButton = create && (
    <Button
      variant="ghost"
      size="icon"
      className="size-[26px] text-muted-foreground hover:text-foreground"
      disabled={create.disabled || create.busy}
      onClick={create.onClick}
      title={create.disabled ? undefined : create.label}
      aria-label={create.label}
    >
      {create.busy ? <Loader2 className="size-[15px] animate-spin" /> : <Plus className="size-[15px]" />}
    </Button>
  )
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-1.5 pl-3.5 pr-2">
        <h2 className="flex min-w-0 items-center gap-2 truncate text-[13px] font-semibold tracking-[-0.005em] text-foreground">
          {t(`sidebar.${tab}`)}
          {tab === 'bots' && (
            <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-amber-400/[0.12] pl-1.5 pr-2 text-[10.5px] font-medium tracking-normal text-amber-400">
              <FlaskConical aria-hidden="true" className="size-[11px]" />
              {t('sidebar.experimental')}
            </span>
          )}
        </h2>
        <div className="no-drag ml-auto flex shrink-0 items-center gap-0.5">
          {create &&
            (create.disabled && create.disabledReason ? (
              // A disabled button gets no hover: its wrapper says why.
              <span title={create.disabledReason}>{createButton}</span>
            ) : (
              createButton
            ))}
          {viewMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-[26px] text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                  title={t('sidebar.viewOptions')}
                  aria-label={t('sidebar.viewOptions')}
                >
                  <MoreHorizontal className="size-[15px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {viewMenu}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {children}

      <div className="shrink-0 px-2 pb-2">
        <div className="flex h-[30px] items-center gap-1.5 rounded-lg border border-border bg-black/20 pl-2.5 pr-1 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-border-strong focus-within:shadow-[0_0_0_3px_rgba(237,234,227,0.07)]">
          <Search aria-hidden="true" className="size-3.5 shrink-0" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                onQueryChange('')
              }
            }}
            placeholder={filterLabel}
            aria-label={filterLabel}
            className="h-full w-full min-w-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label={t('sidebar.clearFilter')}
              title={t('sidebar.clearFilter')}
              className="grid size-[18px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </div>
      </div>
    </>
  )
}
