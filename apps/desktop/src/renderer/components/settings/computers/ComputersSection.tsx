import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Laptop, Link2, Lock, Plus, RadioTower, Wifi } from 'lucide-react'
import type { HostId } from '../../../../shared/host-key'
import type { HostView } from '../../../../shared/hosts'
import { formatPeerAddress, type PeerComputerView, peerHostId } from '../../../../shared/peer'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { HostTile, hostStatusLabelKey } from '@/components/sidebar/HostSection'
import { hostSectionStatus } from '@/lib/hosts/host-status'
import { useHosts } from '@/lib/hosts/use-hosts'
import { acceptPeerOverview, usePeerOverview } from '@/lib/peer/use-peer-overview'
import type { SettingsRequest } from '@/lib/use-settings'
import { cn } from '@/lib/utils'
import { ConnectComputerDialog } from './ConnectComputerDialog'
import { PeerPortSetting } from './PeerPortSetting'

/** What each system is called, in any language. */
const OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' } as const

/** The dialog Settings shows: blank, or to pair again with a computer paired before. */
type Connecting = { address: string; seq: number } | null

/**
 * Settings → Computers: whether this computer lets the owner's other computers use it, its name, and the computers it
 * paired with, which can be opened, disconnected or removed. A local section: it is about this computer, whichever
 * host the window shows.
 */
export function ComputersSection({
  request,
  onOpenHost,
}: {
  request?: SettingsRequest | null
  /** Shows a paired computer in the sidebar's machine switcher and leaves Settings. */
  onOpenHost: (hostId: HostId) => void
}) {
  const { t, i18n } = useTranslation('ui')
  const overview = usePeerOverview()
  const hosts = useHosts()
  const [connecting, setConnecting] = useState<Connecting>(null)
  const [removing, setRemoving] = useState<PeerComputerView | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const time = useMemo(() => new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }), [i18n.language])
  const date = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  )

  useEffect(() => {
    if (overview) setName(overview.name)
  }, [overview?.name])

  useEffect(() => {
    const target = request?.connectComputer
    if (!target) return
    const known = typeof target === 'string' ? overview?.computers.find((item) => item.deviceId === target) : null
    setConnecting({ address: known?.address ?? '', seq: request.seq })
    // Opened once per request: the overview arriving later does not open it again.
  }, [request?.seq])

  if (!overview) return <p className="text-xs text-muted-foreground">{t('settings.computers.loading')}</p>

  const toggleHosting = async () => {
    setBusy(true)
    try {
      acceptPeerOverview(await window.api.peerSetHosting(!overview.hosting))
    } finally {
      setBusy(false)
    }
  }

  const commitName = async () => {
    const next = name.trim()
    if (!next || next === overview.name) return setName(overview.name)
    acceptPeerOverview(await window.api.peerRename(next))
  }

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      acceptPeerOverview(await window.api.peerRemove(removing.deviceId))
      setRemoving(null)
    } finally {
      setBusy(false)
    }
  }

  const hostOf = (deviceId: string): HostView | null => hosts.find((host) => host.id === peerHostId(deviceId)) ?? null
  const paused = overview.pairingPausedUntil

  return (
    <>
      <section data-settings-computers className="flex flex-col gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Laptop className="size-4 text-muted-foreground" />
            {t('settings.computers.title')}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.computers.desc')}</p>
        </div>

        {!overview.available && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-artifact-warn/[0.08] px-2.5 py-2 text-xs leading-relaxed text-foreground"
          >
            <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0 text-artifact-warn" />
            {t('settings.computers.keyringUnavailable')}
          </p>
        )}

        <button
          type="button"
          role="switch"
          aria-checked={overview.hosting}
          data-peer-hosting
          onClick={() => void toggleHosting()}
          disabled={busy || (!overview.available && !overview.hosting)}
          className={cn(
            'flex items-start gap-2.5 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]',
            !overview.available && !overview.hosting && 'pointer-events-none opacity-50'
          )}
        >
          <RadioTower className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{t('settings.computers.hostingTitle')}</div>
            <div className="text-[11px] leading-snug text-muted-foreground">{t('settings.computers.hostingDesc')}</div>
          </div>
          <span
            className={cn(
              'mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
              overview.hosting ? 'bg-primary' : 'bg-white/15'
            )}
          >
            <span
              className={cn('size-4 rounded-full bg-white transition-transform', overview.hosting && 'translate-x-4')}
            />
          </span>
        </button>

        {overview.hosting && overview.port !== null && (
          <p data-peer-visible className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Wifi aria-hidden="true" className="mt-px size-3.5 shrink-0 text-status-ready" />
            <span>
              {t('settings.computers.visibleAs', { name: overview.name })}{' '}
              <span className="font-mono text-[11px] text-foreground">
                {overview.addresses.map((address) => formatPeerAddress(address, overview.port ?? 0)).join(' · ')}
              </span>
              . {t('settings.computers.visibleHint')}
            </span>
          </p>
        )}
        {overview.hosting && overview.hostingError && (
          <p role="alert" className="rounded-md border border-destructive/40 p-3 text-xs text-destructive">
            {t('settings.computers.hostingFailed', { error: overview.hostingError })}
          </p>
        )}
        {paused !== null && (
          <p className="flex items-start gap-2 rounded-md bg-artifact-warn/[0.08] px-2.5 py-2 text-xs leading-relaxed text-foreground">
            <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0 text-artifact-warn" />
            {t('settings.computers.paused', { time: time.format(new Date(paused)) })}
          </p>
        )}

        <div className="flex items-center gap-3 rounded-lg border border-border bg-white/[0.02] px-3 py-2.5">
          <label htmlFor="peer-name" className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">{t('settings.computers.nameTitle')}</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">
              {t('settings.computers.nameDesc')}
            </span>
          </label>
          <Input
            id="peer-name"
            value={name}
            maxLength={128}
            disabled={!overview.available}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setName(overview.name)
            }}
            className="h-8 w-56 shrink-0"
          />
        </div>
        <PeerPortSetting overview={overview} />
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Link2 className="size-4 text-muted-foreground" />
              {t('settings.computers.pairedTitle')}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.computers.pairedDesc')}</p>
          </div>
          <button
            type="button"
            data-peer-connect
            disabled={!overview.available}
            onClick={() => setConnecting({ address: '', seq: Date.now() })}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-indigo-500 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            <Plus className="size-3.5" />
            {t('settings.computers.connect')}
          </button>
        </div>

        {overview.computers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs leading-relaxed text-muted-foreground">
            {t('settings.computers.empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-white/[0.02] px-3">
            {overview.computers.map((computer) => {
              const host = hostOf(computer.deviceId)
              const status = host ? hostSectionStatus(host) : null
              const parts: string[] = [OS_LABEL[computer.os]]
              if (status) parts.push(t(hostStatusLabelKey(status)))
              if (computer.connectedSince !== null)
                parts.push(t('settings.computers.usingSince', { time: time.format(new Date(computer.connectedSince)) }))
              if (!status && computer.connectedSince === null)
                parts.push(
                  computer.lastSeenAt
                    ? t('settings.computers.lastSeen', { date: date.format(new Date(computer.lastSeenAt)) })
                    : t('settings.computers.pairedAt', { date: date.format(new Date(computer.pairedAt)) })
                )
              return (
                <li
                  key={computer.deviceId}
                  data-peer-computer={computer.deviceId}
                  className="flex items-center gap-3 py-2.5"
                >
                  <HostTile
                    host={
                      host ?? {
                        id: peerHostId(computer.deviceId),
                        remote: true,
                        tint: null,
                        state: 'offline',
                        environment: null,
                        peer: { deviceId: computer.deviceId, problem: null },
                      }
                    }
                    status={computer.connectedSince !== null ? 'online' : status}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{computer.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{parts.join(' · ')}</p>
                  </div>
                  {host && status === 'online' && (
                    <Button size="sm" variant="outline" onClick={() => onOpenHost(host.id)}>
                      {t('settings.computers.open')}
                    </Button>
                  )}
                  {(status === 'removed' || status === 'identity-changed') && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConnecting({ address: computer.address ?? '', seq: Date.now() })}
                    >
                      {t('sidebar.peerPairAgain')}
                    </Button>
                  )}
                  {computer.connectedSince !== null && (
                    <Button size="sm" variant="ghost" onClick={() => void window.api.peerDisconnect(computer.deviceId)}>
                      {t('settings.computers.disconnect')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    aria-label={t('settings.computers.removeNamed', { name: computer.name })}
                    onClick={() => setRemoving(computer)}
                  >
                    {t('settings.computers.remove')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {connecting && (
        <ConnectComputerDialog
          key={connecting.seq}
          initialAddress={connecting.address}
          onOpenHost={(hostId) => {
            setConnecting(null)
            onOpenHost(hostId)
          }}
          onClose={() => setConnecting(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={t('settings.computers.removeTitle', { name: removing.name })}
          message={t('settings.computers.removeConfirm', { name: removing.name })}
          confirmLabel={t('settings.computers.remove')}
          destructive
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  )
}
