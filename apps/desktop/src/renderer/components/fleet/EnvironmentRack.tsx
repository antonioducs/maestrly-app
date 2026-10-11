import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Plus } from 'lucide-react'
import { FLEET_ENVIRONMENT_LIMITS, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { activityLabel } from '@/lib/fleet/format'
import { cn } from '@/lib/utils'
import { botStatusDot } from './BotChatHeader'

const COLUMNS = 4

/**
 * The bots of an environment as its bays: an environment holds a fixed number of bots, and each one occupies a bay lit
 * in its own color, with what it is doing. The next free bay creates a bot here; the empty ones only finish the row.
 */
export function EnvironmentRack({
  bots,
  joinHint,
  onOpenBot,
  onCreateBot,
}: {
  bots: FleetBot[]
  /** Why no bot can join right now, or null when one can. */
  joinHint: string | null
  onOpenBot: (id: string) => void
  onCreateBot: () => void
}) {
  const { t } = useTranslation('fleet')
  const max = FLEET_ENVIRONMENT_LIMITS.botsMax
  const full = bots.length >= max
  const slots = full ? bots.length : bots.length + 1
  // Narrow, the rack has two columns: a vacant bay finishes a row of two only when one bay is alone on it.
  const vacant = Math.min(max, Math.ceil(slots / COLUMNS) * COLUMNS) - slots
  return (
    <section aria-labelledby="fleet-environment-bots">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="fleet-environment-bots" className="text-[15px] font-semibold">
          {t('environment.bots')}
        </h2>
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {t('environment.capacity', { count: bots.length, max })}
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-2.5 @sm:grid-cols-2 @2xl:grid-cols-4">
        {bots.map((bot) => {
          const activity = bot.activity ? activityLabel(bot.activity, bot.status) : null
          const asleep = bot.status === 'offline' || bot.status === 'starting'
          return (
            <li key={bot.id} className="flex min-w-0">
              <button
                type="button"
                data-environment-bay={bot.id}
                onClick={() => onOpenBot(bot.id)}
                style={{ '--bay-tint': bot.tint } as CSSProperties}
                className={cn(
                  'group relative flex h-[108px] min-w-0 flex-1 flex-col justify-between gap-2 overflow-hidden rounded-xl border border-border px-[13px] pb-3 pt-[15px] text-left transition-[border-color,transform] duration-200 hover:-translate-y-px hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                  // A strip lit in the bot's color tops its bay; a stopped bot's bay goes dark.
                  "before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-b-sm before:content-['']",
                  asleep
                    ? 'bg-white/[0.016] before:bg-white/15'
                    : 'bg-[radial-gradient(130%_75%_at_50%_-12%,color-mix(in_srgb,var(--bay-tint)_17%,transparent),transparent_64%)] bg-white/[0.028] before:bg-[var(--bay-tint)] before:shadow-[0_0_16px_1px_color-mix(in_srgb,var(--bay-tint)_70%,transparent)]',
                  bot.status === 'working' && 'before:animate-pulse motion-reduce:before:animate-none'
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-[30px] shrink-0 items-center justify-center rounded-[9px] text-[13px] font-semibold text-white',
                      asleep && 'brightness-75 grayscale'
                    )}
                    style={{ background: bot.tint }}
                  >
                    {bot.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-semibold">{bot.name}</span>
                    {bot.role && <span className="block truncate text-[11.5px] text-muted-foreground">{bot.role}</span>}
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="inline-flex items-center gap-1.5 text-xs text-foreground/75">
                    <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${botStatusDot(bot.status)}`} />
                    {t(`status.${bot.status}`)}
                  </span>
                  {activity && (
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {t(activity.key, activity.values)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
        {!full && (
          <li className="flex min-w-0">
            <button
              type="button"
              disabled={!!joinHint}
              aria-describedby={joinHint ? 'fleet-environment-join-hint' : undefined}
              onClick={onCreateBot}
              className="flex h-[108px] min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong px-3 text-center text-[12.5px] text-foreground/75 transition-colors hover:border-white/25 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border-strong disabled:hover:bg-transparent"
            >
              <span
                aria-hidden="true"
                className="grid size-[30px] place-items-center rounded-[9px] border border-border-strong"
              >
                <Plus className="size-4" />
              </span>
              {t('environment.newBotHere')}
            </button>
          </li>
        )}
        {Array.from({ length: vacant }, (_, index) => (
          <li
            key={`vacant-${index}`}
            aria-hidden="true"
            // In two columns only the bay that finishes a row of two stays.
            className={cn('hidden min-w-0 @2xl:flex', index === 0 && slots % 2 === 1 && '@sm:flex')}
          >
            <span className="h-[108px] flex-1 rounded-xl border border-dashed border-white/[0.055]" />
          </li>
        ))}
      </ul>
      {joinHint && (
        <p id="fleet-environment-join-hint" className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-amber-300">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          {joinHint}
        </p>
      )}
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">{t('environment.sharedNote')}</p>
    </section>
  )
}
