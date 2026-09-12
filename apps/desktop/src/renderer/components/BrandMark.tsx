import markFull from '../assets/brand/mark-full.svg?raw'
import markWhite from '../assets/brand/mark-white.svg?raw'
import lockupFull from '../assets/brand/lockup-full.svg?raw'
import lockupWhite from '../assets/brand/lockup-white.svg?raw'
import { cn } from '@/lib/utils'

type BrandVariant = 'mark' | 'lockup'
type BrandTone = 'full' | 'mono'

const SVGS: Record<BrandVariant, Record<BrandTone, string>> = {
  mark: { full: markFull, mono: markWhite },
  lockup: { full: lockupFull, mono: lockupWhite },
}

export function BrandMark({
  variant = 'mark',
  tone = 'mono',
  className,
  'aria-label': ariaLabel,
}: {
  variant?: BrandVariant
  tone?: BrandTone
  className?: string
  'aria-label'?: string
}) {
  return (
    <span
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn('inline-flex shrink-0 [&>svg]:block [&>svg]:h-full [&>svg]:w-auto', className)}
      dangerouslySetInnerHTML={{ __html: SVGS[variant][tone] }}
    />
  )
}
