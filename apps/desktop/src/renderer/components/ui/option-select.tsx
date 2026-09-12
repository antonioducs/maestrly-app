import type { ComponentPropsWithoutRef } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

// Prefix every value so that an empty string remains a selectable default/off option.
// Radix reserves the actual empty string for its placeholder.
const encodeValue = (value: string) => `option:${value}`

type OptionSelectProps = Omit<ComponentPropsWithoutRef<typeof SelectTrigger>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

export function OptionSelect({ value, onValueChange, children, disabled, ...props }: OptionSelectProps) {
  return (
    <Select value={encodeValue(value)} onValueChange={(next) => onValueChange(next.slice(7))} disabled={disabled}>
      <SelectTrigger {...props}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  )
}

export function SelectOption({ value, ...props }: ComponentPropsWithoutRef<typeof SelectItem>) {
  return <SelectItem value={encodeValue(value)} {...props} />
}
