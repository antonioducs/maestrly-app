import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, Plus, Server } from 'lucide-react'
import type { FleetConnectionState, FleetServerId, FleetServerView } from '../../../shared/fleet-servers'
import { instanceColor } from '../../../shared/instance-color'
import { fleetServerAddress, fleetServerName } from '@/lib/fleet/server-label'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const STATE_DOT: Record<FleetConnectionState, string> = {
  connected: 'bg-status-ready',
  connecting: 'animate-pulse bg-artifact-warn',
  reconnecting: 'animate-pulse bg-artifact-warn',
  unauthorized: 'bg-destructive',
  incompatible: 'bg-destructive',
  unconfigured: 'bg-muted-foreground',
}

/** A server's mark: its own tint, stable across windows, and a dot for its connection. */
function ServerTile({ server }: { server: FleetServerView }) {
  const [r, g, b] = instanceColor(server.id).rgb
  const style: CSSProperties = {
    backgroundColor: `rgba(${r}, ${g}, ${b}, 0.15)`,
    color: `rgb(${r}, ${g}, ${b})`,
    boxShadow: `inset 0 0 0 1px rgba(${r}, ${g}, ${b}, 0.24)`,
  }
  return (
    <span aria-hidden="true" className="relative grid size-[26px] shrink-0 place-items-center rounded-lg" style={style}>
      <Server style={{ width: 14, height: 14 }} />
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[#19191c]',
          STATE_DOT[server.connection.state]
        )}
      />
    </span>
  )
}

/**
 * Which paired server the Bots tab shows, where the machine switcher sits on the other tabs: each server with its
 * address, its connection and what waits for the owner there, and the way to add another.
 */
export function FleetServerSwitcher({
  servers,
  selectedId,
  pending,
  onSelect,
  onAdd,
}: {
  servers: FleetServerView[]
  selectedId: FleetServerId
  /** Inbox items waiting for the owner, by server. */
  pending: Record<string, number>
  onSelect: (id: FleetServerId) => void
  onAdd: () => void
}) {
  const { t } = useTranslation('fleet')
  const selected = servers.find((server) => server.id === selectedId) ?? servers[0]
  if (!selected) return null
  const summary = (server: FleetServerView) => {
    const count = pending[server.id] ?? 0
    if (server.connection.state === 'connected' && count > 0) return t('botServer.servers.pending', { count })
    return t(`botServer.servers.status.${server.connection.state}`)
  }
  const elsewhere = servers.some((server) => server.id !== selected.id && (pending[server.id] ?? 0) > 0)
  return (
    <div className="flex shrink-0 px-2 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-fleet-server-switcher={selected.id}
            aria-label={t('botServer.servers.switcher', { name: fleetServerName(selected.connection) })}
            className="no-drag flex h-[42px] min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-border-strong bg-white/[0.03] pl-[7px] pr-1.5 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/[0.06]"
          >
            <ServerTile server={selected} />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[12.5px] font-semibold leading-tight text-foreground">
                {fleetServerName(selected.connection)}
              </span>
              <span className="truncate text-[10.5px] leading-tight text-muted-foreground">{summary(selected)}</span>
            </span>
            <span className="relative shrink-0 text-muted-foreground">
              <ChevronsUpDown className="size-3.5" />
              {elsewhere && (
                <span className="absolute -right-0.5 -top-1 size-1.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" />
              )}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
            {t('botServer.servers.heading')}
          </div>
          {servers.map((server) => {
            const count = pending[server.id] ?? 0
            return (
              <DropdownMenuItem
                key={server.id}
                data-fleet-server-option={server.id}
                onSelect={() => onSelect(server.id)}
                className="gap-2.5 py-1.5"
              >
                <ServerTile server={server} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">{fleetServerName(server.connection)}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {fleetServerAddress(server.connection)} · {t(`botServer.servers.status.${server.connection.state}`)}
                  </span>
                </span>
                {count > 0 && (
                  <span
                    aria-label={t('botServer.servers.pending', { count })}
                    className="rounded-full bg-red-500/90 px-1.5 text-[10px] font-semibold leading-4 text-white"
                  >
                    {count}
                  </span>
                )}
                {server.id === selected.id && <Check className="size-3.5 text-foreground" />}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem data-fleet-add-server onSelect={onAdd} className="gap-2.5 py-1.5 text-muted-foreground">
            <Plus className="size-3.5" />
            <span className="text-[13px]">{t('botServer.servers.addMenu')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
