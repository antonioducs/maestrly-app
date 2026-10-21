import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronsUpDown, Settings, Unplug } from 'lucide-react'
import { peerHostId } from '../../../shared/peer'
import { HostTile } from '@/components/sidebar/HostSection'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePeerOverview } from '@/lib/peer/use-peer-overview'

/**
 * At the bottom of the sidebar while the owner's other computers use this one: who they are, since when, and a way to
 * disconnect each. Nothing shows while no other computer uses this one.
 */
export function PeerInUseChip({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t, i18n } = useTranslation('ui')
  const overview = usePeerOverview()
  const time = useMemo(() => new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }), [i18n.language])
  const using = (overview?.computers ?? []).filter((computer) => computer.connectedSince !== null)
  if (!using.length) return null
  const label =
    using.length === 1
      ? t('peerChip.oneLabel', { name: using[0].name })
      : t('peerChip.manyLabel', { name: using[0].name, count: using.length - 1 })
  return (
    <div className="shrink-0 px-2 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-peer-in-use
            className="no-drag flex w-full items-center gap-2 rounded-lg border border-border bg-white/[0.03] px-2.5 py-1.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/[0.06]"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-status-ready shadow-[0_0_0_3px_rgba(91,214,160,0.18)]"
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{t('peerChip.heading')}</div>
          {using.map((computer) => (
            <div key={computer.deviceId} data-peer-using={computer.deviceId}>
              <div className="flex items-center gap-2.5 px-2 py-1.5">
                <HostTile
                  host={{
                    id: peerHostId(computer.deviceId),
                    remote: true,
                    tint: null,
                    state: 'online',
                    environment: null,
                    peer: { deviceId: computer.deviceId, problem: null },
                  }}
                  status="online"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">{computer.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {t('peerChip.since', { time: time.format(new Date(computer.connectedSince ?? 0)) })}
                  </span>
                </span>
              </div>
              <DropdownMenuItem
                data-peer-disconnect={computer.deviceId}
                onSelect={() => void window.api.peerDisconnect(computer.deviceId)}
                className="gap-2 py-1.5"
              >
                <Unplug className="size-3.5" />
                <span className="text-[13px]">{t('peerChip.disconnect', { name: computer.name })}</span>
              </DropdownMenuItem>
            </div>
          ))}
          <p className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">{t('peerChip.access')}</p>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenSettings} className="gap-2 py-1.5 text-muted-foreground">
            <Settings className="size-3.5" />
            <span className="text-[13px]">{t('peerChip.settings')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
