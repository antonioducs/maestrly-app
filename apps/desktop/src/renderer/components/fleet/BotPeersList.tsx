import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { cn } from '@/lib/utils'
import { SettingsSwitch } from './SettingsSwitch'

/** The other bots, one row each, with a switch that lets this bot message it. The whole row toggles. */
export function BotPeersList({
  bots,
  selfId,
  environments,
  value,
  onChange,
}: {
  bots: FleetBot[]
  selfId: string
  /** Given when bots live in environments: each row names its bot's. */
  environments?: FleetEnvironment[]
  value: string[]
  onChange: (value: string[]) => void
}) {
  const { t } = useTranslation('fleet')
  const peers = bots.filter((bot) => bot.id !== selfId)
  if (!peers.length)
    return (
      <div className="rounded-xl border border-border bg-foreground/[0.025] p-4 text-[13px] text-muted-foreground">
        {t('botFields.noPeers')}
      </div>
    )
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-foreground/[0.025]">
      {peers.map((peer) => {
        const allowed = value.includes(peer.id)
        const environment = environments?.find((item) => item.id === peer.environmentId)
        const running = peer.lifecycle === 'running'
        return (
          <li key={peer.id}>
            {/* A label clicks its switch: the whole row toggles, the switch alone takes the focus. */}
            <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.02]">
              <span
                aria-hidden="true"
                className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] text-[11px] font-semibold text-white"
                style={{ background: peer.tint }}
              >
                {peer.name.charAt(0).toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13.5px] font-medium">{peer.name}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className={cn('size-1.5 rounded-full', running ? 'bg-status-ready' : 'bg-muted-foreground/70')}
                  />
                  {t(`status.${peer.status}`)}
                  {environment && ` · ${t('botSettings.peerEnvironment', { name: environment.name })}`}
                </span>
              </span>
              <SettingsSwitch
                checked={allowed}
                label={t('botSettings.peerSwitch', { name: peer.name })}
                onChange={() => onChange(allowed ? value.filter((id) => id !== peer.id) : [...value, peer.id])}
              />
            </label>
          </li>
        )
      })}
    </ul>
  )
}
