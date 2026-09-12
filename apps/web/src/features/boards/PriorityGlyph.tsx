import { ChevronsUp, ChevronUp, Equal, ChevronDown, Minus } from 'lucide-react'
import type { Card } from '@maestrly/protocol'
import { t } from '../../i18n/index.js'

const icons = { urgent: ChevronsUp, high: ChevronUp, medium: Equal, low: ChevronDown, none: Minus } as const

/** Priority as glyph + text so colour never carries the meaning alone. */
export function PriorityGlyph({ priority }: { priority: Card['priority'] }) {
  const Icon = icons[priority] ?? Equal
  return (
    <span className={'priority priority-' + priority} title={t('Priority')}>
      <Icon size={12} aria-hidden="true" />
      {t(priority)}
    </span>
  )
}
