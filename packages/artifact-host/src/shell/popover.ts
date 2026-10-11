// One popover at a time, below the button that opened it. Escape or a press outside closes it.
import { h } from './dom.js'

interface Open {
  el: HTMLElement
  anchor: HTMLElement
}

let current: Open | null = null

export const popoverOpen = (): boolean => current !== null

export function closePopover(restoreFocus = true): void {
  if (!current) return
  const { el, anchor } = current
  current = null
  el.remove()
  anchor.setAttribute('aria-expanded', 'false')
  if (restoreFocus && anchor.isConnected) anchor.focus()
}

/**
 * Opens the popover, or closes it when it is already open from this button. `build` fills it and may return what
 * should take the focus; otherwise its first control does.
 */
export function togglePopover(
  anchor: HTMLElement,
  className: string,
  build: (popover: HTMLElement) => HTMLElement | undefined,
  align: 'end' | 'center' = 'end'
): void {
  if (current?.anchor === anchor) return closePopover()
  closePopover(false)
  const el = h('div', { class: `popover ${className}` })
  const focus = build(el)
  document.body.append(el)
  anchor.setAttribute('aria-expanded', 'true')
  const box = anchor.getBoundingClientRect()
  const width = el.offsetWidth
  const left = align === 'center' ? box.left + box.width / 2 - width / 2 : box.right - width
  el.style.left = `${Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - width - 8))}px`
  el.style.top = `${box.bottom + 8}px`
  el.style.maxHeight = `${Math.max(160, window.innerHeight - box.bottom - 20)}px`
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closePopover()
  })
  current = { el, anchor }
  ;(focus ?? el.querySelector<HTMLElement>('button, input, [tabindex]'))?.focus()
}

document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target as Node
    if (current && !current.el.contains(target) && !current.anchor.contains(target)) closePopover(false)
  },
  true
)
window.addEventListener('resize', () => closePopover(false))
