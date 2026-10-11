// Small DOM helpers. Every text reaches the page through `textContent`; nothing is ever parsed as HTML.

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function button(label: string, className: string, onClick?: () => void): HTMLButtonElement {
  const node = element('button', className, label)
  node.type = 'button'
  if (onClick) node.addEventListener('click', onClick)
  return node
}

let sequence = 0

/** A labeled text field; `multiline` makes it a textarea. */
export function field(options: {
  label: string
  maxLength: number
  multiline?: boolean
  type?: string
  autocomplete?: string
}): { root: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement } {
  const id = `field-${++sequence}`
  const root = element('div', 'field')
  const label = element('label', undefined, options.label)
  label.htmlFor = id
  const input = options.multiline ? element('textarea') : element('input')
  input.id = id
  input.maxLength = options.maxLength
  if (input instanceof HTMLInputElement) {
    input.type = options.type ?? 'text'
    input.autocomplete = (options.autocomplete ?? 'off') as AutoFill
  } else input.rows = 3
  root.append(label, input)
  return { root, input }
}

/** Runs the action with the button disabled, so a second click cannot send it twice. */
export async function busy(control: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  if (control.disabled) return
  control.disabled = true
  try {
    await action()
  } finally {
    control.disabled = false
  }
}

export type Child = Node | string | number | null | undefined | false | readonly Child[]
type Attribute = string | number | boolean | null | undefined
export type Props = Record<string, Attribute | ((event: never) => void)>

/** Appends what is there, skipping the `false` and `undefined` that conditional children leave. Text stays text. */
export function put<T extends Node>(parent: T, ...children: Child[]): T {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) put(parent, ...(child as readonly Child[]))
    else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return parent
}

/**
 * Builds an element. `class` sets the class, `on<event>` functions become listeners, `true` sets an empty attribute,
 * and `false`, `null` and `undefined` leave the attribute out. Children are appended as nodes or text.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener)
    else if (key === 'class') node.className = String(value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  return put(node, ...children)
}

/** Copies text, reporting whether the browser allowed it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

let toasts: HTMLElement | null = null

/** A short confirmation at the bottom of the window, announced to assistive technology. */
export function toast(text: string, action?: { label: string; run: () => void }): void {
  if (!toasts?.isConnected) {
    toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
    document.body.append(toasts)
  }
  const note = h('div', { class: 'toast' }, h('span', {}, text))
  const dismiss = () => note.remove()
  if (action)
    note.append(
      h(
        'button',
        {
          type: 'button',
          class: 'toast-action',
          onclick: () => {
            dismiss()
            action.run()
          },
        },
        action.label
      )
    )
  toasts.append(note)
  setTimeout(dismiss, action ? 6000 : 3200)
}
