/** Copy presentation only. The child has no application bootstrap or second chat runtime. */
export function prepareChatDocument(source: Document, destination: Document): () => void {
  const base = destination.createElement('base')
  base.href = source.baseURI
  destination.head.append(base)
  destination.body.style.cssText = 'margin:0;height:100vh;overflow:hidden'
  const syncAttributes = () => {
    destination.documentElement.className = source.documentElement.className
    destination.documentElement.lang = source.documentElement.lang
    destination.documentElement.style.cssText = source.documentElement.style.cssText
    destination.body.className = source.body.className
  }
  const syncStyles = () => {
    destination.head.querySelectorAll('[data-chat-window-style]').forEach((node) => node.remove())
    for (const node of source.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const copy = node.cloneNode(true) as HTMLElement
      copy.dataset.chatWindowStyle = ''
      // Resolve relative packaged styles against the original entry, not about:blank.
      if (node.tagName === 'LINK') (copy as HTMLLinkElement).href = (node as HTMLLinkElement).href
      destination.head.append(copy)
    }
  }
  syncAttributes()
  syncStyles()
  const attributes = new MutationObserver(syncAttributes)
  attributes.observe(source.documentElement, { attributes: true })
  attributes.observe(source.body, { attributes: true, attributeFilter: ['class'] })
  const styles = new MutationObserver(syncStyles)
  styles.observe(source.head, { childList: true, subtree: true, characterData: true })
  return () => {
    attributes.disconnect()
    styles.disconnect()
  }
}

/** Keep selection and scroll anchored while adopting the same live React portal container. */
export function moveChatSurface(surface: HTMLElement, parent: HTMLElement): void {
  const source = surface.ownerDocument
  const selection = source.getSelection()
  const range =
    selection?.rangeCount && surface.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null
  const active = source.activeElement
  const focus = active && surface.contains(active) && 'focus' in active ? (active as HTMLElement) : null
  const scroll = [surface, ...surface.querySelectorAll<HTMLElement>('*')]
    .filter((node) => node.scrollTop !== 0 || node.scrollLeft !== 0)
    .map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }))
  parent.append(surface)
  for (const item of scroll) {
    item.node.scrollTop = item.top
    item.node.scrollLeft = item.left
  }
  if (focus) focus.focus({ preventScroll: true })
  if (range) {
    const destinationSelection = surface.ownerDocument.getSelection()
    destinationSelection?.removeAllRanges()
    destinationSelection?.addRange(range)
  }
}
