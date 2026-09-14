import { Children, isValidElement, useRef, useState, type ReactNode } from 'react'
import { MenuSelect, MenuSelectContent, MenuSelectItem, MenuSelectTrigger, MenuSelectValue } from '@maestrly/ui'

type Props = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children: ReactNode
  name?: string
  required?: boolean
  disabled?: boolean
  'aria-label'?: string
}
type Option = { value?: string; children?: ReactNode; disabled?: boolean }
const encode = (value: string) => 'option:' + value

/** Native option children stay declarative; selection and keyboard handling use
 * the same Radix primitives as Maestrly App. FormData receives the original value. */
export function Choice({ value, defaultValue, onValueChange, children, name, required, disabled, ...label }: Props) {
  const options = Children.toArray(children).filter(isValidElement<Option>)
  const first = options.find(option => !option.props.disabled)
  const [local, setLocal] = useState(defaultValue)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const resolved = value ?? local ?? String(first?.props.value ?? first?.props.children ?? '')
  return <>
    <MenuSelect value={required && resolved === '' ? '' : encode(resolved)} open={open} onOpenChange={setOpen} disabled={disabled} required={required}
      onValueChange={next => { const selected = next.slice(7); setLocal(selected); onValueChange?.(selected) }}>
      <MenuSelectTrigger ref={trigger} className="bot-select-trigger" {...label}><MenuSelectValue /></MenuSelectTrigger>
      <MenuSelectContent className="bot-select-menu" container={trigger.current?.closest('dialog') ?? undefined} sideOffset={5}>
        {options.map(option => {
          const id = String(option.props.value ?? option.props.children ?? '')
          return <MenuSelectItem key={id} value={encode(id)} disabled={option.props.disabled}>{option.props.children}</MenuSelectItem>
        })}
      </MenuSelectContent>
    </MenuSelect>
    {name && <input type="hidden" name={name} value={resolved} disabled={disabled} />}
  </>
}
