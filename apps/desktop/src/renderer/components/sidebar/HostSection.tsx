import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Loader2,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Play,
  Server,
  SquareArrowOutUpRight,
} from 'lucide-react'
import type { HostView } from '../../../shared/hosts'
import { cn } from '@/lib/utils'
import { hostSectionStatus } from '@/lib/hosts/host-status'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const STATUS_LABEL = {
  connecting: 'sidebar.hostConnecting',
  reconnecting: 'sidebar.hostReconnecting',
  incompatible: 'sidebar.hostIncompatible',
  stopped: 'sidebar.hostStopped',
  starting: 'sidebar.hostStarting',
  failed: 'sidebar.hostFailed',
  offline: 'sidebar.hostOffline',
} as const

const STATUS_DETAIL = {
  connecting: 'sidebar.hostConnectingDetail',
  reconnecting: 'sidebar.hostReconnectingDetail',
  stopped: 'sidebar.hostStoppedDetail',
  starting: 'sidebar.hostStartingDetail',
  failed: 'sidebar.hostFailedDetail',
  offline: 'sidebar.hostOfflineDetail',
} as const

export interface HostSectionActions {
  /** Creates a chat or adds a workspace on this host, depending on the tab. */
  onAdd: () => void
  addLabel: string
  adding?: boolean
  onRetry: () => void
  onStart: () => void
  onManage: () => void
  /** Shows or hides the host's archived conversations; absent while the host lists nothing. */
  onToggleArchived?: () => void
  showArchived?: boolean
}

/**
 * The heading of one host's chats or workspaces. It appears only when the sidebar shows more than one host: this
 * computer's heading has a name and nothing else.
 */
export function HostSectionHeader({ host, actions }: { host: HostView; actions?: HostSectionActions }) {
  const { t } = useTranslation('ui')
  const status = hostSectionStatus(host)
  const name = host.remote ? host.label || t('sidebar.hostUnnamed') : t('sidebar.hostThisComputer')
  const Icon = host.remote ? Server : Monitor
  return (
    <div
      data-host-section-header={host.id}
      className="group/host mt-1 flex h-7 items-center gap-1.5 border-t border-border/40 px-2 first:mt-0 first:border-t-0"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {name}
      </span>
      {status !== 'online' && (
        <span
          data-host-status={status}
          className={cn(
            'shrink-0 rounded px-1 text-[10px]',
            status === 'incompatible' || status === 'failed'
              ? 'bg-destructive/15 text-destructive'
              : 'bg-white/[0.05] text-muted-foreground'
          )}
        >
          {t(STATUS_LABEL[status])}
        </span>
      )}
      <div className="min-w-0 flex-1" />
      {actions && (
        <>
          {status === 'online' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 shrink-0"
              disabled={actions.adding}
              onClick={actions.onAdd}
              title={actions.addLabel}
              aria-label={actions.addLabel}
            >
              {actions.adding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                title={t('sidebar.hostActions')}
                aria-label={t('sidebar.hostActions')}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(status === 'connecting' || status === 'reconnecting' || status === 'incompatible') && (
                <DropdownMenuItem onClick={actions.onRetry}>
                  <RefreshCw /> {t('sidebar.hostRetry')}
                </DropdownMenuItem>
              )}
              {(status === 'stopped' || status === 'failed') && (
                <DropdownMenuItem onClick={actions.onStart}>
                  <Play /> {t('sidebar.hostStart')}
                </DropdownMenuItem>
              )}
              {actions.onToggleArchived && (
                <DropdownMenuItem onClick={actions.onToggleArchived}>
                  <Archive /> {actions.showArchived ? t('sidebar.hideArchived') : t('sidebar.hostShowArchived')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={actions.onManage}>
                <SquareArrowOutUpRight /> {t('sidebar.hostManage')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}

/** What a remote host's section says in place of its lists while it cannot list them. */
export function HostSectionNotice({
  host,
  appVersion,
  actions,
}: {
  host: HostView
  appVersion: string | null
  actions: HostSectionActions
}) {
  const { t } = useTranslation('ui')
  const status = hostSectionStatus(host)
  if (status === 'online') return <p className="px-3 py-1 text-xs text-muted-foreground">{t('sidebar.hostLoading')}</p>
  const detail =
    status === 'incompatible'
      ? host.hostVersion && appVersion
        ? t('sidebar.hostIncompatibleDetail', { hostVersion: host.hostVersion, appVersion })
        : t('sidebar.hostIncompatibleDetailUnknown')
      : t(STATUS_DETAIL[status])
  let action: ReactNode = null
  if (status === 'stopped' || status === 'failed')
    action = (
      <Button variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={actions.onStart}>
        {t('sidebar.hostStart')}
      </Button>
    )
  else if (status === 'incompatible')
    action = (
      <Button variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={actions.onManage}>
        {t('sidebar.hostManage')}
      </Button>
    )
  else if (status === 'reconnecting' || status === 'offline')
    action = (
      <Button variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={actions.onRetry}>
        {t('sidebar.hostRetry')}
      </Button>
    )
  return (
    <div data-host-notice={status} className="flex flex-col items-start gap-1.5 px-3 py-1.5">
      <p className="text-xs leading-snug text-muted-foreground">{detail}</p>
      {action}
    </div>
  )
}
