import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { isBlockingReason, type PluginCompatibility } from '../../../shared/plugins'
import { reasonText } from './plugin-ui'

const LEVEL_CLASS = {
  portable: 'bg-emerald-500/15 text-emerald-300',
  unavailable: 'bg-red-500/15 text-red-300',
} as const

/**
 * Whether a plugin works the same with every model. The tooltip gives why it does not, or notes that some parts are
 * left out, or the level's meaning.
 */
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
  const blocking = compatibility.reasons.find((reason) => isBlockingReason(reason.code))
  const title =
    compatibility.level === 'unavailable' && (blocking ?? compatibility.reasons[0])
      ? reasonText(t, blocking ?? compatibility.reasons[0])
      : compatibility.reasons.length
        ? t('compat.notIncluded')
        : t(`compat.levelHint.${compatibility.level}`)
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
