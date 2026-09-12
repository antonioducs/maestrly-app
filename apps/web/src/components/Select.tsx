import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'

interface Option { value: string; label: string }
export function Select({ value, onChange, options, label, disabled = false, id, compact = false }: {
  value: string; onChange(value: string): void; options: Option[]; label: string
  disabled?: boolean; id?: string; compact?: boolean
}) {
  const listId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const search = useRef({ text: '', time: 0 })
  const selected = options.find(option => option.value === value)
  function close() { menu.current?.hidePopover(); setOpen(false) }
  function show() {
    if (disabled || !options.length) return
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    menu.current?.showPopover()
    setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    function position() {
      const button = trigger.current, popup = menu.current
      if (!button || !popup) return
      const rect = button.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 210), innerWidth - 16)
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12
      const height = Math.max(0, Math.min(288, Math.max(below, above)))
      popup.style.width = width + 'px'
      popup.style.maxHeight = height + 'px'
      popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px'
      popup.style.top = (below >= Math.min(288, popup.scrollHeight) || below >= above
        ? rect.bottom + 6 : Math.max(8, rect.top - Math.min(height, popup.scrollHeight) - 6)) + 'px'
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open, options])
  useLayoutEffect(() => {
    if (open) menu.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  function choose(index: number) {
    const option = options[index]
    if (!option || disabled) return
    close(); trigger.current?.focus(); onChange(option.value)
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); close() }; return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      if (!open) { show(); return }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      if (!open) show()
      const now = Date.now()
      const text = (now - search.current.time < 700 ? search.current.text : '') + event.key
      search.current = { text, time: now }
      const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(text.toLocaleLowerCase()))
      if (index >= 0) setActive(index)
    }
  }
  return <>
    <button ref={trigger} id={id} type="button" className={'select-trigger' + (compact ? ' select-compact' : '')}
      role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} aria-haspopup="listbox"
      aria-activedescendant={open ? listId + '-' + active : undefined} disabled={disabled}
      onKeyDown={keyDown} onClick={() => open ? close() : show()}>
      <span>{selected?.label ?? label}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    <div ref={menu} id={listId} popover="auto" role="listbox" aria-label={label} className="select-menu"
      onToggle={event => setOpen(event.newState === 'open')}>
      {options.map((option, index) => <div key={option.value} id={listId + '-' + index} role="option"
        aria-selected={option.value === value} className={'select-option' + (active === index ? ' highlighted' : '')}
        onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value ? <Check size={15} aria-hidden="true" /> : null}
      </div>)}
    </div>
  </>
}
