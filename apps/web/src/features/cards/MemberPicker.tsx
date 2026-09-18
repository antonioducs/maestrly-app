import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Search, X } from 'lucide-react'
import { t } from '../../i18n/index.js'

export interface Member {
  id: string
  name: string
  role?: string
  email?: string
}
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase()
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? fold(text).indexOf(fold(query)) : -1
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}

/**
 * Searchable multi-select for people. Selected members are listed inline with a remove control; the
 * popover filters by name or e-mail and supports the keyboard (↑↓ Home End Enter Esc). Never a native select.
 */
export function MemberPicker({
  members,
  selected,
  onChange,
  disabled = false,
  label,
}: {
  members: Member[]
  selected: string[]
  onChange(ids: string[]): void
  disabled?: boolean
  label: string
}) {
  const listId = useId()
  const trigger = useRef<HTMLButtonElement>(null),
    popover = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0)
  const chosen = members.filter((member) => selected.includes(member.id))
  const rows = useMemo(() => {
    const needle = fold(query.trim())
    return members.filter(
      (member) => !needle || fold(member.name).includes(needle) || fold(member.email ?? '').includes(needle)
    )
  }, [members, query])
  const highlighted = Math.min(active, Math.max(0, rows.length - 1))
  function position() {
    const button = trigger.current,
      panel = popover.current
    if (!button || !panel) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(320, innerWidth - 16)
    const below = innerHeight - rect.bottom - 12
    const height = Math.min(400, panel.scrollHeight || 400)
    panel.style.width = width + 'px'
    panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px'
    panel.style.top = (below >= height || below >= rect.top ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)) + 'px'
  }
  function show() {
    if (disabled) return
    setQuery('')
    setActive(0)
    popover.current?.showPopover()
    setOpen(true)
  }
  function close(focusTrigger = true) {
    popover.current?.hidePopover()
    setOpen(false)
    if (focusTrigger) trigger.current?.focus()
  }
  useLayoutEffect(() => {
    if (!open) return
    position()
    search.current?.focus()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  useLayoutEffect(() => {
    if (open) popover.current?.querySelector('[role=listbox]')?.children[highlighted]?.scrollIntoView({ block: 'nearest' })
  }, [open, highlighted])
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) setActive((highlighted + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : rows.length - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[highlighted]
      if (row) toggle(row.id)
    } else if (event.key === 'Tab') close(false)
  }
  return (
    <div className="assignee-picker">
      <ul className="assignee-picker-selected" aria-label={label}>
        {chosen.map((member) => (
          <li key={member.id}>
            <i className="member-avatar" aria-hidden="true">
              {initials(member.name)}
            </i>
            <span>{member.name}</span>
            {!disabled ? (
              <button type="button" aria-label={t('Remove {name}', { name: member.name })} onClick={() => toggle(member.id)}>
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
        {!chosen.length ? <li className="assignee-picker-empty">{t('Nobody assigned')}</li> : null}
      </ul>
      {!disabled ? (
        <button
          ref={trigger}
          type="button"
          className="quiet af-small member-picker-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => (open ? close() : show())}
        >
          {t('Add assignee')}
        </button>
      ) : null}
      <div
        ref={popover}
        id={listId}
        popover="auto"
        role="dialog"
        aria-label={t('Choose assignees')}
        className="assignee-picker-popover"
        onToggle={(event) => {
          if (event.newState === 'closed') setOpen(false)
        }}
      >
        <div className="assignee-picker-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={search}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId + '-list'}
            aria-autocomplete="list"
            aria-activedescendant={rows[highlighted] ? listId + '-' + rows[highlighted].id : undefined}
            aria-label={t('Search members')}
            placeholder={t('Search by name or e-mail…')}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={keyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id={listId + '-list'} role="listbox" aria-multiselectable="true" className="assignee-picker-list">
          {rows.map((member, index) => (
            <li
              key={member.id}
              id={listId + '-' + member.id}
              role="option"
              aria-selected={selected.includes(member.id)}
              aria-label={member.name}
              className={index === highlighted ? 'highlighted' : ''}
              onPointerMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(member.id)}
            >
              <i className="member-avatar" aria-hidden="true">
                {initials(member.name)}
              </i>
              <div>
                <b>
                  <Highlight text={member.name} query={query.trim()} />
                </b>
                <small>
                  {member.email ? <Highlight text={member.email} query={query.trim()} /> : null}
                  {member.email && member.role ? ' · ' : ''}
                  {member.role ? t(member.role) : ''}
                </small>
              </div>
              <span className="member-tick" aria-hidden="true">
                <Check size={12} />
              </span>
            </li>
          ))}
        </ul>
        {!rows.length ? <p className="assignee-picker-none">{t('No members found.')}</p> : null}
        <div className="assignee-picker-foot">
          <span>{t('{count} selected', { count: String(selected.length) })}</span>
          <button type="button" className="quiet af-small" onClick={() => close()}>
            {t('Done')}
          </button>
        </div>
      </div>
    </div>
  )
}
