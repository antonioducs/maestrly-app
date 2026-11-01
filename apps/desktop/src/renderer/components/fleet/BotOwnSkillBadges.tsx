import { useTranslation } from 'react-i18next'
import type { FleetBotOwnSkillSummary } from '@maestrly/bot-fleet-protocol'
import { cn } from '@/lib/utils'

const badge = 'rounded border border-border px-1.5 text-xs text-muted-foreground'

/** Where a skill came from and what holds it: who made and changed it, a waiting proposal, scripts, a lock. */
export function BotOwnSkillBadges({ skill }: { skill: FleetBotOwnSkillSummary }) {
  const { t } = useTranslation('fleet')
  const items: Array<{ key: string; text: string; title?: string; tone?: 'warn' }> = [
    { key: 'origin', text: t(`ownSkills.badge.createdBy.${skill.createdBy}`) },
    ...(skill.lastEditedBy === 'owner' && skill.createdBy !== 'owner'
      ? [{ key: 'edited', text: t('ownSkills.badge.edited') }]
      : []),
    ...(skill.status === 'proposed'
      ? [{ key: 'proposed', text: t('ownSkills.badge.proposed'), tone: 'warn' as const }]
      : skill.proposal
        ? [{ key: 'proposal', text: t('ownSkills.badge.proposal'), tone: 'warn' as const }]
        : []),
    ...(skill.status === 'archived' ? [{ key: 'archived', text: t('ownSkills.badge.archived') }] : []),
    ...(skill.hasScripts ? [{ key: 'scripts', text: t('ownSkills.badge.scripts') }] : []),
    ...(skill.shadowed
      ? [
          {
            key: 'shadowed',
            text: t('ownSkills.badge.shadowed'),
            title: t('ownSkills.badge.shadowedTitle'),
            tone: 'warn' as const,
          },
        ]
      : []),
    ...(skill.locked ? [{ key: 'locked', text: t('ownSkills.badge.locked') }] : []),
  ]
  return (
    <span className="flex flex-wrap items-center gap-1">
      {items.map((item) => (
        <span
          key={item.key}
          title={item.title}
          className={cn(badge, item.tone === 'warn' && 'border-amber-300/40 text-amber-200')}
        >
          {item.text}
        </span>
      ))}
    </span>
  )
}
