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
