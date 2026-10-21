import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, Laptop, Monitor, Plus, Server } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { HostView } from '../../../shared/hosts'
import type { HostId } from '../../../shared/host-key'
import { hostTint } from '@/lib/hosts/host-tint'
import { cn } from '@/lib/utils'
import { hostSectionStatus, type HostSectionStatus } from '@/lib/hosts/host-status'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { HostActivity } from './sidebar-hosts'

const STATUS_LABEL = {
  connecting: 'sidebar.hostConnecting',
  reconnecting: 'sidebar.hostReconnecting',
  incompatible: 'sidebar.hostIncompatible',
  stopped: 'sidebar.hostStopped',
  starting: 'sidebar.hostStarting',
  failed: 'sidebar.hostFailed',
  offline: 'sidebar.hostOffline',
  'not-hosting': 'sidebar.peerNotHosting',
  removed: 'sidebar.peerRemoved',
  disconnected: 'sidebar.peerDisconnected',
  'identity-changed': 'sidebar.peerIdentityChanged',
} as const

/** The few words that say how a machine is reached, as its entry in the machine switcher says them. */
export const hostStatusLabelKey = (status: HostSectionStatus): string =>
  status === 'online' ? 'sidebar.hostOnline' : STATUS_LABEL[status]

/** What a paired computer's section says while it lists nothing live; `{{host}}` is its name. */
const PEER_DETAIL = {
  connecting: 'sidebar.peerConnectingDetail',
  reconnecting: 'sidebar.peerReconnectingDetail',
  offline: 'sidebar.peerOfflineDetail',
  'not-hosting': 'sidebar.peerNotHostingDetail',
  removed: 'sidebar.peerRemovedDetail',
  disconnected: 'sidebar.peerDisconnectedDetail',
  'identity-changed': 'sidebar.peerIdentityChangedDetail',
} as const

const STATUS_DETAIL = {
  connecting: 'sidebar.hostConnectingDetail',
  reconnecting: 'sidebar.hostReconnectingDetail',
  stopped: 'sidebar.hostStoppedDetail',
  starting: 'sidebar.hostStartingDetail',
  failed: 'sidebar.hostFailedDetail',
  offline: 'sidebar.hostOfflineDetail',
} as const

const STATUS_DOT: Record<HostSectionStatus, string> = {
  online: 'bg-status-ready',
  connecting: 'animate-pulse bg-artifact-warn',
  reconnecting: 'animate-pulse bg-artifact-warn',
  starting: 'animate-pulse bg-artifact-warn',
  stopped: 'bg-muted-foreground',
  offline: 'bg-muted-foreground',
  incompatible: 'bg-destructive',
  failed: 'bg-destructive',
  'not-hosting': 'bg-muted-foreground',
  removed: 'bg-destructive',
  disconnected: 'bg-muted-foreground',
  'identity-changed': 'bg-destructive',
}

const TILE_SIZE = {
  lg: { box: 'size-[26px] rounded-lg', icon: 14, dot: 'size-2' },
  md: { box: 'size-[22px] rounded-[7px]', icon: 12, dot: 'size-2' },
  sm: { box: 'size-[18px] rounded-[5px]', icon: 11, dot: 'size-1.5' },
} as const

export function hostName(host: HostView, t: TFunction<'ui'>): string {
  return host.remote
    ? host.label || t(host.peer ? 'sidebar.peerUnnamed' : 'sidebar.hostUnnamed')
    : t('sidebar.hostThisComputer')
}

/**
 * One look for a machine wherever the sidebar shows it: its kind (this computer, another of the owner's computers, or
 * a server), its tint, and a dot for how it is reached.
 */
export function HostTile({
  host,
  size = 'lg',
  status: shown,
}: {
  host: Pick<HostView, 'id' | 'remote' | 'tint' | 'state' | 'environment' | 'peer'>
  size?: keyof typeof TILE_SIZE
  /** What the dot says instead of how this computer reaches the machine; null for no dot. */
  status?: HostSectionStatus | null
}) {
  const status = shown === undefined ? hostSectionStatus(host) : shown
  const [r, g, b] = hostTint(host)
  const Icon = host.peer ? Laptop : host.remote ? Server : Monitor
  const dims = TILE_SIZE[size]
  const style: CSSProperties = {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
    color: `rgb(${r}, ${g}, ${b})`,
    boxShadow: `inset 0 0 0 1px rgba(${r}, ${g}, ${b}, 0.24)`,
  }
  return (
    <span aria-hidden="true" className={cn('relative grid shrink-0 place-items-center', dims.box)} style={style}>
      {/* Inline size: menu items size every svg inside them. */}
      <Icon
        style={{ width: dims.icon, height: dims.icon }}
        className={cn(status && status !== 'online' && status !== 'connecting' && 'opacity-45')}
      />
      {status && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-[#19191c]',
            dims.dot,
            STATUS_DOT[status]
          )}
        />
      )}
    </span>
  )
}

/** How a machine is doing in a few words: why it lists nothing live, or what its conversations do. */
function HostSummary({ host, activity, className }: { host: HostView; activity: HostActivity; className?: string }) {
  const { t } = useTranslation('ui')
  const status = hostSectionStatus(host)
  if (status !== 'online')
    return (
      <span data-host-status={status} className={cn(className, status === 'failed' && 'text-destructive')}>
        {t(STATUS_LABEL[status])}
      </span>
    )
  const parts: ReactNode[] = []
  if (activity.attention)
    parts.push(
      <span key="attention" className="text-[#ff9a9a]">
        {t('sidebar.hostNeedsYou', { count: activity.attention })}
      </span>
    )
  if (activity.working) parts.push(<span key="working">{t('sidebar.hostRunning', { count: activity.working })}</span>)
  if (parts.length === 0) return <span className={className}>{t('sidebar.hostOnline')}</span>
  return <span className={className}>{parts.flatMap((part, i) => (i ? [' · ', part] : [part]))}</span>
}

function summaryText(host: HostView, activity: HostActivity, t: TFunction<'ui'>): string {
  const status = hostSectionStatus(host)
  if (status !== 'online') return t(STATUS_LABEL[status])
  const parts = [
    activity.attention ? t('sidebar.hostNeedsYou', { count: activity.attention }) : '',
    activity.working ? t('sidebar.hostRunning', { count: activity.working }) : '',
  ].filter(Boolean)
  return parts.join(' · ') || t('sidebar.hostOnline')
}

/** Shortcuts beside the switcher: more than this many other machines are only in its menu. */
const MAX_SHORTCUTS = 2

/**
 * Which machine's chats and workspaces the sidebar lists. It appears only when the window reaches more than one: the
 * chosen machine with what it is doing, and a shortcut to each other one, marked when something there needs the person.
 */
export function HostSwitcher({
  hosts,
  selectedId,
  activity,
  onSelect,
  onConnectComputer,
  showQuickTooltip,
  hideQuickTooltip,
}: {
  hosts: HostView[]
  selectedId: HostId
  activity: Record<HostId, HostActivity>
  onSelect: (id: HostId) => void
  /** Opens the dialog that pairs this computer with another one of the owner's. */
  onConnectComputer?: () => void
  showQuickTooltip: (e: { currentTarget: HTMLElement }, text: string, side?: 'below' | 'right') => void
  hideQuickTooltip: () => void
}) {
  const { t } = useTranslation('ui')
  const selected = hosts.find((host) => host.id === selectedId) ?? hosts[0]
  if (!selected) return null
  const none: HostActivity = { attention: 0, working: 0 }
  const others = hosts.filter((host) => host.id !== selected.id)
  const shortcuts = others.slice(0, MAX_SHORTCUTS)
  const hiddenAttention = others.slice(MAX_SHORTCUTS).some((host) => (activity[host.id] ?? none).attention > 0)
  const stacked = shortcuts.length > 1
  return (
    <div className="flex shrink-0 items-stretch gap-1 px-2 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-host-switcher={selected.id}
            aria-label={t('sidebar.hostSwitch', { host: hostName(selected, t) })}
            className="no-drag flex h-[42px] min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-border-strong bg-white/[0.03] pl-[7px] pr-1.5 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/[0.06]"
          >
            <HostTile host={selected} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[12.5px] font-semibold leading-tight text-foreground">
                {hostName(selected, t)}
              </span>
              <HostSummary
                host={selected}
                activity={activity[selected.id] ?? none}
                className="truncate text-[10.5px] leading-tight text-muted-foreground"
              />
            </span>
            <span className="relative shrink-0 text-muted-foreground">
              <ChevronsUpDown className="size-3.5" />
              {hiddenAttention && (
                <span className="absolute -right-0.5 -top-1 size-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" />
              )}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
            {t('sidebar.hostMachines')}
          </div>
          {hosts.map((host) => (
            <DropdownMenuItem
              key={host.id}
              data-host-option={host.id}
              onSelect={() => onSelect(host.id)}
              // Environments of one server are told apart by name; the server they run on is a hover away.
              title={host.server ? `${hostName(host, t)} · ${host.server}` : undefined}
              className="gap-2.5 py-1.5"
            >
              <HostTile host={host} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px]">{hostName(host, t)}</span>
                <HostSummary
                  host={host}
                  activity={activity[host.id] ?? none}
                  className="truncate text-[11px] text-muted-foreground"
                />
              </span>
              {host.id === selected.id && <Check className="size-3.5 text-foreground" />}
            </DropdownMenuItem>
          ))}
          {onConnectComputer && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-host-connect
                onSelect={onConnectComputer}
                className="gap-2.5 py-1.5 text-muted-foreground"
              >
                <Plus className="size-3.5" />
                <span className="text-[13px]">{t('sidebar.peerConnectAnother')}</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {shortcuts.length > 0 && (
        <div role="group" aria-label={t('sidebar.hostOthers')} className="flex w-[26px] shrink-0 flex-col gap-0.5">
          {shortcuts.map((host) => {
            const name = hostName(host, t)
            const summary = summaryText(host, activity[host.id] ?? none, t)
            const label = t('sidebar.hostSwitchTo', { host: name, status: summary })
            const tip = `${name} · ${summary}`
            const status = hostSectionStatus(host)
            return (
              <button
                key={host.id}
                type="button"
                data-host-shortcut={host.id}
                data-host-status={status === 'online' ? undefined : status}
                aria-label={label}
                onClick={() => {
                  hideQuickTooltip()
                  onSelect(host.id)
                }}
                onMouseEnter={(e) => showQuickTooltip(e, tip, 'right')}
                onMouseLeave={hideQuickTooltip}
                onFocus={(e) => e.currentTarget.matches(':focus-visible') && showQuickTooltip(e, tip, 'right')}
                onBlur={hideQuickTooltip}
                className="no-drag relative grid min-h-0 flex-1 place-items-center rounded-[7px] border border-transparent outline-none transition-colors hover:border-border hover:bg-white/[0.045] focus-visible:ring-1 focus-visible:ring-ring"
              >
                <HostTile host={host} size={stacked ? 'sm' : 'md'} />
                {(activity[host.id] ?? none).attention > 0 && (
                  <span className="absolute right-0 top-0.5 size-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] ring-2 ring-[#19191c]" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface HostNoticeActions {
  onRetry: () => void
  onStart: () => void
  onManage: () => void
  /** A paired computer's: pair with it again, or forget it here once it removed this computer. */
  onPair?: () => void
  onForget?: () => void
}

/** What a remote host's section says in place of its lists while it cannot list them. */
export function HostSectionNotice({
  host,
  appVersion,
  actions,
}: {
  host: HostView
  appVersion: string | null
  actions: HostNoticeActions
}) {
  const { t } = useTranslation('ui')
  const status = hostSectionStatus(host)
  if (status === 'online') return <p className="px-3 py-1 text-xs text-muted-foreground">{t('sidebar.hostLoading')}</p>
  const name = hostName(host, t)
  const detail =
    status === 'incompatible'
      ? host.hostVersion && appVersion
        ? t(host.peer ? 'sidebar.peerIncompatibleDetail' : 'sidebar.hostIncompatibleDetail', {
            host: name,
            hostVersion: host.hostVersion,
            appVersion,
          })
        : t(host.peer ? 'sidebar.peerIncompatibleDetailUnknown' : 'sidebar.hostIncompatibleDetailUnknown', {
            host: name,
          })
      : host.peer && status in PEER_DETAIL
        ? t(PEER_DETAIL[status as keyof typeof PEER_DETAIL], { host: name })
        : t(STATUS_DETAIL[status as keyof typeof STATUS_DETAIL])
  const button = (label: string, onClick: () => void) => (
    <Button key={label} variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={onClick}>
      {label}
    </Button>
  )
  const buttons: ReactNode[] = []
  if (status === 'stopped' || status === 'failed') buttons.push(button(t('sidebar.hostStart'), actions.onStart))
  else if (status === 'incompatible')
    buttons.push(button(t(host.peer ? 'sidebar.peerUpdates' : 'sidebar.hostManage'), actions.onManage))
  else if (status === 'reconnecting' || status === 'offline' || status === 'not-hosting')
    buttons.push(button(t('sidebar.hostRetry'), actions.onRetry))
  else if (status === 'disconnected') buttons.push(button(t('sidebar.peerReconnect'), actions.onRetry))
  if ((status === 'removed' || status === 'identity-changed') && actions.onPair)
    buttons.push(button(t('sidebar.peerPairAgain'), actions.onPair))
  if (status === 'removed' && actions.onForget) buttons.push(button(t('sidebar.peerForget'), actions.onForget))
  return (
    <div
      data-host-notice={status}
      className="mx-2 my-1.5 flex flex-col items-start gap-1.5 rounded-lg border border-border bg-white/[0.03] px-2.5 py-2"
    >
      <p className="text-xs leading-snug text-muted-foreground">{detail}</p>
      {buttons.length > 0 && <div className="flex flex-wrap gap-1.5">{buttons}</div>}
    </div>
  )
}
