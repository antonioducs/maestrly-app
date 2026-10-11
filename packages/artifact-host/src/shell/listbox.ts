// A custom single-select listbox (never a native <select>), shown in a popover below its button.
import { type Child, h, put } from './dom.js'
import { icon } from './icons.js'
import { closePopover, togglePopover } from './popover.js'

export interface ListboxItem {
  value: string
  /** A short mark before the label, such as "v3". */
  badge?: string
  label: string
  /** A small tag after the label, such as "current". */
  tag?: string
  /** A second, quieter line. */
  meta?: string
}

export interface ListboxOptions {
  label: string
  className?: string
  /** What the button shows for the chosen item. */
  trigger: (item: ListboxItem | undefined) => Child
  /** The button's accessible name for the chosen item. */
  triggerLabel: (item: ListboxItem | undefined) => string
  onChange(value: string): void
}

let sequence = 0

export function createListbox(options: ListboxOptions): {
  button: HTMLButtonElement
  update(items: ListboxItem[], value: string): void
} {
  const id = `listbox-${++sequence}`
  let items: ListboxItem[] = []
  let value = ''
  const button = h('button', {
    type: 'button',
    class: options.className ?? 'listbox-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  })

  function build(popover: HTMLElement): HTMLElement {
    let active = Math.max(
      0,
      items.findIndex((item) => item.value === value)
    )
    const list = h('ul', { class: 'options', role: 'listbox', tabindex: '0', 'aria-label': options.label })
    const rows = items.map((item, index) =>
      h(
        'li',
        {
          id: `${id}-${index}`,
          class: 'option',
          role: 'option',
          'aria-selected': String(item.value === value),
          onclick: () => choose(index),
          onpointermove: () => {
            if (active === index) return
            active = index
            paint()
          },
        },
        item.badge !== undefined && h('span', { class: 'option-badge' }, item.badge),
        h(
          'span',
          { class: 'option-text' },
          h('span', { class: 'option-label' }, item.label, item.tag && h('em', { class: 'option-tag' }, item.tag)),
          item.meta && h('span', { class: 'option-meta' }, item.meta)
        ),
        item.value === value && icon('check', 15)
      )
    )
    list.append(...rows)
    function paint(): void {
      rows.forEach((row, index) => row.classList.toggle('is-active', index === active))
      const row = rows[active]
      if (!row) return
      list.setAttribute('aria-activedescendant', row.id)
      row.scrollIntoView({ block: 'nearest' })
    }
    function choose(index: number): void {
      const item = items[index]
      closePopover()
      if (item && item.value !== value) options.onChange(item.value)
    }
    list.addEventListener('keydown', (event) => {
      const last = rows.length - 1
      if (event.key === 'ArrowDown') active = Math.min(last, active + 1)
      else if (event.key === 'ArrowUp') active = Math.max(0, active - 1)
      else if (event.key === 'Home') active = 0
      else if (event.key === 'End') active = last
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        return choose(active)
      } else if (event.key === 'Tab') return closePopover(false)
      else return
      event.preventDefault()
      paint()
    })
    popover.append(list)
    queueMicrotask(paint)
    return list
  }

  button.addEventListener('click', () => togglePopover(button, 'listbox-popover', build, 'center'))
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    togglePopover(button, 'listbox-popover', build, 'center')
  })

  return {
    button,
    update(nextItems, nextValue) {
      items = nextItems
      value = nextValue
      const current = items.find((item) => item.value === value)
      button.replaceChildren()
      put(button, options.trigger(current), icon('down', 14))
      button.setAttribute('aria-label', options.triggerLabel(current))
    },
  }
}
