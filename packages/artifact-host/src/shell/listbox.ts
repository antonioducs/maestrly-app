// A custom single-select listbox (never a native <select>), styled like the app's Select.

export interface ListboxItem {
  value: string
  label: string
  hint?: string
}

export interface ListboxOptions {
  label: string
  items: ListboxItem[]
  value: string
  onChange(value: string): void
}

let sequence = 0

export function createListbox(options: ListboxOptions): HTMLElement {
  const id = `listbox-${++sequence}`
  const { items } = options
  let selected = Math.max(
    0,
    items.findIndex((item) => item.value === options.value)
  )
  let active = selected

  const root = document.createElement('div')
  root.className = 'listbox'

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'listbox-trigger'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  button.setAttribute('aria-controls', `${id}-list`)
  const buttonText = document.createElement('span')
  const chevron = document.createElement('span')
  chevron.className = 'listbox-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  button.append(buttonText, chevron)

  const list = document.createElement('ul')
  list.id = `${id}-list`
  list.className = 'listbox-menu'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', options.label)
  list.tabIndex = -1
  list.hidden = true

  const rows = items.map((item, index) => {
    const row = document.createElement('li')
    row.id = `${id}-option-${index}`
    row.className = 'listbox-option'
    row.setAttribute('role', 'option')
    const label = document.createElement('span')
    label.textContent = item.label
    row.append(label)
    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'listbox-hint'
      hint.textContent = item.hint
      row.append(hint)
    }
    row.addEventListener('mousemove', () => {
      if (active !== index) {
        active = index
        render()
      }
    })
    row.addEventListener('click', () => choose(index))
    return row
  })
  list.append(...rows)
  root.append(button, list)

  function render(): void {
    const current = items[selected]
    buttonText.textContent = current?.label ?? ''
    button.setAttribute('aria-label', `${options.label}: ${current?.label ?? ''}`)
    rows.forEach((row, index) => {
      row.setAttribute('aria-selected', String(index === selected))
      row.classList.toggle('active', index === active)
    })
    if (!list.hidden && rows[active]) {
      list.setAttribute('aria-activedescendant', rows[active].id)
      rows[active].scrollIntoView({ block: 'nearest' })
    }
  }

  function onOutside(event: Event): void {
    if (!root.contains(event.target as Node)) close(false)
  }

  function open(): void {
    if (!list.hidden || items.length === 0) return
    active = selected
    list.hidden = false
    button.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', onOutside, true)
    render()
    list.focus()
  }

  function close(returnFocus: boolean): void {
    if (list.hidden) return
    list.hidden = true
    list.removeAttribute('aria-activedescendant')
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    render()
    if (returnFocus) button.focus()
  }

  function choose(index: number): void {
    const changed = index !== selected
    selected = index
    close(true)
    if (changed && items[index]) options.onChange(items[index].value)
  }

  button.addEventListener('click', () => (list.hidden ? open() : close(true)))
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      open()
    }
  })
  list.addEventListener('keydown', (event) => {
    const last = items.length - 1
    switch (event.key) {
      case 'ArrowDown':
        active = Math.min(last, active + 1)
        break
      case 'ArrowUp':
        active = Math.max(0, active - 1)
        break
      case 'Home':
        active = 0
        break
      case 'End':
        active = last
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        return
      case 'Escape':
        event.preventDefault()
        close(true)
        return
      case 'Tab':
        close(false)
        return
      default:
        return
    }
    event.preventDefault()
    render()
  })

  render()
  return root
}
