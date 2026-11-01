import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { FLEET_BOT_OWN_SKILLS_FEATURE, type FleetBot, type FleetBotOwnSkillsList } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useFleetServerId } from '@/lib/fleet/server-context'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { BotOwnSkillBadges } from './BotOwnSkillBadges'
import { BotOwnSkillDetail } from './BotOwnSkillDetail'
import { SavesNowTag, SettingsSection } from './SettingsSection'
import { SettingsSwitch } from './SettingsSwitch'

/** Whether the gateway and the bot's environment both serve the bot's own skills, and which one to update if not. */
export function ownSkillsAvailability(fleet: FleetController, bot: FleetBot): 'ready' | 'gateway' | 'bot' {
  if (!fleet.state.connection.features.includes(FLEET_BOT_OWN_SKILLS_FEATURE)) return 'gateway'
  return bot.capabilities.includes(FLEET_BOT_OWN_SKILLS_FEATURE) ? 'ready' : 'bot'
}

/** The skills the bot keeps for itself: what it saved, what waits for review, and whether its changes wait for it. */
export function BotOwnSkillsSection({
  bot,
  fleet,
  id = 'fleet-bot-own-skills',
}: {
  bot: FleetBot
  fleet: FleetController
  id?: string
}) {
  const serverId = useFleetServerId()
  const { t, i18n } = useTranslation('fleet')
  const availability = ownSkillsAvailability(fleet, bot)
  const [list, setList] = useState<FleetBotOwnSkillsList | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (availability !== 'ready') return
    let alive = true
    window.api.fleetListBotOwnSkills(serverId, bot.id).then(
      (value) => {
        if (!alive) return
        setList(value)
        setError('')
      },
      (cause) => {
        if (alive) setError(fleetErrorText(cause, t))
      }
    )
    return () => {
      alive = false
    }
  }, [serverId, bot.id, bot.status, availability, refresh, t])

  async function setReview(review: 'auto' | 'approve') {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      setList(await window.api.fleetSetBotOwnSkillsSettings(serverId, bot.id, { review }))
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const archived = list?.skills.filter((skill) => skill.status === 'archived').length ?? 0
  // Proposals first: they wait for the owner.
  const shown = (list?.skills ?? [])
    .filter((skill) => showArchived || skill.status !== 'archived')
    .sort((a, b) => Number(Boolean(b.proposal)) - Number(Boolean(a.proposal)))
  const usage = (uses: number, lastUsedAt: number | null) =>
    uses && lastUsedAt
      ? t('ownSkills.uses', {
          count: uses,
          date: new Date(lastUsedAt).toLocaleDateString(i18n.language, { dateStyle: 'medium' }),
        })
      : t('ownSkills.unused')

  return (
    <SettingsSection
      id={id}
      title={t('ownSkills.heading')}
      note={t('ownSkills.description')}
      aside={
        availability === 'ready' && !selected ? (
          <>
            <SavesNowTag />
            {archived > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((value) => !value)}
              >
                {t(showArchived ? 'ownSkills.hideArchived' : 'ownSkills.showArchived', { count: archived })}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {availability !== 'ready' ? (
        <p
          role="status"
          data-testid="bot-own-skills-update"
          className="flex items-start gap-2 rounded-xl border border-amber-300/35 bg-amber-300/10 px-3.5 py-3 text-[13px]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          {t(availability === 'gateway' ? 'ownSkills.unavailable.gateway' : 'ownSkills.unavailable.bot')}
        </p>
      ) : selected ? (
        <BotOwnSkillDetail
          key={selected}
          botId={bot.id}
          name={selected}
          onBack={() => setSelected(null)}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {list && (
            <div className="flex items-start gap-3 rounded-xl border border-border bg-foreground/[0.025] px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13.5px]">{t('ownSkills.review')}</span>
                <span className="text-xs text-muted-foreground">{t('ownSkills.reviewNote')}</span>
              </div>
              <SettingsSwitch
                checked={list.review === 'approve'}
                label={t('ownSkills.review')}
                disabled={busy}
                onChange={() => void setReview(list.review === 'approve' ? 'auto' : 'approve')}
              />
            </div>
          )}
          {list && shown.length === 0 ? (
            <div className="rounded-xl border border-border bg-foreground/[0.025] p-4 text-[13px] text-muted-foreground">
              {t('ownSkills.empty')}
            </div>
          ) : (
            list && (
              <ul className="divide-y divide-border rounded-xl border border-border bg-foreground/[0.025]">
                {shown.map((skill) => (
                  <li key={skill.name}>
                    <button
                      type="button"
                      aria-label={t('ownSkills.open', { name: skill.name })}
                      onClick={() => setSelected(skill.name)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span
                        className={cn(
                          'flex min-w-0 flex-1 flex-col gap-1',
                          skill.status === 'archived' && 'opacity-60'
                        )}
                      >
                        <span className="font-mono text-[13.5px]">{skill.name}</span>
                        {skill.description && (
                          <span className="line-clamp-2 text-[13px] text-foreground/75">{skill.description}</span>
                        )}
                        <BotOwnSkillBadges skill={skill} />
                        <span className="text-xs text-muted-foreground">{usage(skill.uses, skill.lastUsedAt)}</span>
                      </span>
                      <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
          {!list && !error && <p className="text-[13px] text-muted-foreground">{t('ownSkills.loading')}</p>}
        </div>
      )}
      {error && !selected && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}
