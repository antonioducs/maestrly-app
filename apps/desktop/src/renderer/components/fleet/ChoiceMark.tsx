import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Radio-style mark of an option card: filled with a check when selected, so the choice never rests on tint alone. */
export function ChoiceMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong'
      )}
    >
      {selected && <Check className="size-3" strokeWidth={3} />}
    </span>
  )
}
