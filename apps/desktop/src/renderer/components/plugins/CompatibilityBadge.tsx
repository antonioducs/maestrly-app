import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { PluginCompatibility } from '../../../shared/plugins'
import { reasonText } from './plugin-ui'

const LEVEL_CLASS = {
  portable: 'bg-emerald-500/15 text-emerald-300',
  partial: 'bg-amber-500/15 text-amber-300',
  unavailable: 'bg-red-500/15 text-red-300',
} as const

/** Compatibility level, with its first reason (or the level's meaning) as the tooltip. */
export function CompatibilityBadge({
  compatibility,
  className,
}: {
  compatibility: PluginCompatibility | null
  className?: string
}) {
  const { t } = useTranslation('plugins')
  if (!compatibility)
    return (
      <span className={cn('rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground', className)}>
        {t('browse.unknownCompatibility')}
      </span>
    )
  const first = compatibility.reasons[0]
  const title = first ? reasonText(t, first) : t(`compat.levelHint.${compatibility.level}`)
  return (
    <span
      title={title}
      data-compatibility={compatibility.level}
      className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', LEVEL_CLASS[compatibility.level], className)}
    >
      {t(`compat.level.${compatibility.level}`)}
    </span>
  )
}
