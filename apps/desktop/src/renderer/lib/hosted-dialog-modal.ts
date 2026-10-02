/** Modal effects belong to the adopted DOM document, never the IPC renderer window. */
type OutsideEvent<T extends Event> = CustomEvent<{ originalEvent: T }>
const modalContents = new WeakSet<HTMLElement>()
const stacks = new WeakMap<Document, HTMLElement[]>()
const scrollStates = new WeakMap<Document, { value: string; priority: string }>()
const inertStates = new WeakMap<Document, Map<HTMLElement, boolean>>()

function updateInertness(doc: Document) {
  const previous = inertStates.get(doc)
  previous?.forEach((inert, element) => {
    element.inert = inert
  })
  const saved = new Map<HTMLElement, boolean>()
  inertStates.set(doc, saved)
  const top = stacks.get(doc)?.findLast((content) => modalContents.has(content))
  if (!top || top.ownerDocument !== doc) return
  for (let branch: HTMLElement | null = top; branch && branch !== doc.body; branch = branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement?.children ?? [])) {
      // The overlay must remain clickable. Everything inside the content (including
      // SearchSelect panels) remains interactive; background chat UI does not.
      if (sibling === branch || sibling.hasAttribute('data-hosted-dialog-overlay')) continue
      const element = sibling as HTMLElement
      saved.set(element, element.inert)
      element.inert = true
    }
  }
}

export function hostedDialogTabStops(content: HTMLElement): HTMLElement[] {
  return Array.from(content.querySelectorAll<HTMLElement>('*'))
    .filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled, [type="hidden"]') &&
        !element.closest('[inert], [hidden]') &&
        element.getClientRects().length > 0 &&
        content.ownerDocument.defaultView?.getComputedStyle(element).visibility !== 'hidden'
    )
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity))
}

export function installHostedDialogModal(
  content: HTMLElement,
  options: {
    onEscape: (event: KeyboardEvent) => void
    onOpenAutoFocus?: (event: Event) => void
    onCloseAutoFocus?: (event: Event) => void
    autoFocus: boolean
    modal: boolean
    onPointerDownOutside?: (event: OutsideEvent<PointerEvent>) => void
    onFocusOutside?: (event: OutsideEvent<FocusEvent>) => void
    onInteractOutside?: (event: OutsideEvent<PointerEvent> | OutsideEvent<FocusEvent>) => void
    onDismiss: () => void
  }
) {
  const doc = content.ownerDocument
  const stack = stacks.get(doc) ?? []
  stacks.set(doc, stack)
  const previousFocus = doc.activeElement as HTMLElement | null
  const overflow = doc.body.style.getPropertyValue('overflow')
  const overflowPriority = doc.body.style.getPropertyPriority('overflow')
  const first = !stack.some((entry) => modalContents.has(entry))
  if (options.modal) modalContents.add(content)
  stack.push(content)
  if (first && options.modal) {
    scrollStates.set(doc, { value: overflow, priority: overflowPriority })
    doc.body.style.setProperty('overflow', 'hidden')
  }
  updateInertness(doc)
  const isTop = () => stack.at(-1) === content && content.ownerDocument === doc
  const focusFirst = () => (hostedDialogTabStops(content)[0] ?? content).focus({ preventScroll: true })
  const openEvent = new Event('hostedDialog.openAutoFocus', { cancelable: true })
  if (options.autoFocus) options.onOpenAutoFocus?.(openEvent)
  if (!openEvent.defaultPrevented && !content.contains(doc.activeElement)) focusFirst()
  let interactedOutside = false
  const outsideEvent = <T extends Event>(name: string, event: T): OutsideEvent<T> => {
    const outside = new CustomEvent(name, { cancelable: true, detail: { originalEvent: event } })
    ;(event.target as EventTarget | null)?.dispatchEvent(outside)
    return outside
  }
  const isTrigger = (event: Event) =>
    (event.target as Element | null)?.closest?.('[aria-controls]')?.getAttribute('aria-controls') === content.id
  const onFocus = (event: FocusEvent) => {
    if (!isTop() || content.contains(event.target as Node)) return
    const outside = outsideEvent('hostedDialog.focusOutside', event)
    options.onFocusOutside?.(outside)
    options.onInteractOutside?.(outside)
    if (options.modal) focusFirst()
    else if (!outside.defaultPrevented && !isTrigger(event)) {
      interactedOutside = true
      options.onDismiss()
    }
  }
  const onPointer = (event: PointerEvent) => {
    if (!isTop() || content.contains(event.target as Node)) return
    const outside = outsideEvent('hostedDialog.pointerDownOutside', event)
    options.onPointerDownOutside?.(outside)
    options.onInteractOutside?.(outside)
    if (outside.defaultPrevented || isTrigger(event)) return
    if (options.modal && (event.button !== 0 || event.ctrlKey)) return
    interactedOutside = true
    options.onDismiss()
  }
  const onKey = (event: KeyboardEvent) => {
    if (!isTop() || event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.stopImmediatePropagation()
      options.onEscape(event)
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    if (!options.modal && !content.contains(doc.activeElement)) return
    const stops = hostedDialogTabStops(content)
    const index = stops.indexOf(doc.activeElement as HTMLElement)
    if (!options.modal && index >= 0 && (event.shiftKey ? index > 0 : index < stops.length - 1)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index + 1) % stops.length
    ;(stops[next] ?? content).focus({ preventScroll: true })
  }
  const onScroll = (event: Event) => {
    if (options.modal && isTop() && !content.contains(event.target as Node)) event.preventDefault()
  }
  doc.addEventListener('wheel', onScroll, { passive: false })
  doc.addEventListener('touchmove', onScroll, { passive: false })
  // Window capture listeners (SearchSelect) get first refusal on Escape.
  doc.addEventListener('keydown', onKey, true)
  doc.addEventListener('focusin', onFocus)
  doc.addEventListener('pointerdown', onPointer)
  const observer = new MutationObserver(() => updateInertness(doc))
  observer.observe(doc.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    doc.removeEventListener('wheel', onScroll)
    doc.removeEventListener('touchmove', onScroll)
    doc.removeEventListener('keydown', onKey, true)
    doc.removeEventListener('focusin', onFocus)
    doc.removeEventListener('pointerdown', onPointer)
    stack.splice(stack.indexOf(content), 1)
    modalContents.delete(content)
    updateInertness(doc)
    if (options.modal && !stack.some((entry) => modalContents.has(entry))) {
      const original = scrollStates.get(doc)
      if (original?.value) doc.body.style.setProperty('overflow', original.value, original.priority)
      else doc.body.style.removeProperty('overflow')
      scrollStates.delete(doc)
    }
    const closeEvent = new Event('hostedDialog.closeAutoFocus', { cancelable: true })
    // Adoption is not a close: retain the same form and do not run close callbacks.
    if (content.ownerDocument === doc) options.onCloseAutoFocus?.(closeEvent)
    if (
      !closeEvent.defaultPrevented &&
      (options.modal || !interactedOutside) &&
      previousFocus?.isConnected &&
      previousFocus.ownerDocument === doc &&
      !previousFocus.closest('[inert]') &&
      doc.hasFocus()
    )
      previousFocus.focus({ preventScroll: true })
  }
}
