import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderPlus, Search, PanelLeft, Layers } from 'lucide-react'
import { instanceBadgeStyle } from '../../../shared/instance-color'
import type { AppInfo } from '../../../preload'
import { cn } from '@/lib/utils'
import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/ui/button'

export function SidebarHeader({
  query,
  onQueryChange,
  onCollapseSidebar,
  onOpenAbout,
  onNewGroup,
  onAddWorkspace,
}: {
  query: string
  onQueryChange: (value: string) => void
  onCollapseSidebar: () => void
  onOpenAbout: () => void
  onNewGroup: () => Promise<void>
  onAddWorkspace: () => void
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

      <div className="drag flex h-9 items-center justify-between gap-2 hairline-b px-2.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <BrandMark variant="mark" tone="mono" className="h-3.5 opacity-90" />
          {t('sidebar.workspaces')}
        </span>
        <div className="no-drag flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => void onNewGroup()}
            title={t('sidebar.newGroup')}
          >
            <Layers className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onAddWorkspace}
            title={t('sidebar.addWorkspace')}
          >
            <FolderPlus className="size-4" />
          </Button>
        </div>
      </div>

      {/* Conversation search */}
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-input px-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('sidebar.filterPlaceholder')}
            className="h-6 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
    </>
  )
}
