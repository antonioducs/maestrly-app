import { ipcRenderer } from 'electron'
import { isFloatTab, type FloatTab } from '../shared/tool-tabs'

type PinSender = (convId: string, tab: FloatTab, pinned: boolean) => void

export interface FloatingStripButton {
  classList: { toggle: (token: string, force?: boolean) => boolean }
  dataset: Record<string, string | undefined>
  title: string
  addEventListener: (type: 'click', listener: () => void) => void
}

export interface FloatingStripDocument {
  readyState: string
  querySelector: (selector: string) => FloatingStripButton | null
  addEventListener: (type: 'DOMContentLoaded', listener: () => void, options?: { once?: boolean }) => void
}

declare const document: FloatingStripDocument | undefined

export function bindFloatingStripPin(
  doc: FloatingStripDocument,
  send: PinSender = (convId, tab, pinned) => ipcRenderer.send('float:set-pinned', convId, tab, pinned)
): boolean {
  const btn = doc.querySelector('button[data-maestrly-floating-pin]')
  if (!btn) return false
  const convId = btn.dataset.convId
  const tab = btn.dataset.tab
  if (!convId || !isFloatTab(tab)) return false

  let pinned = btn.dataset.pinned === 'true'
  const render = (): void => {
    btn.classList.toggle('on', pinned)
    btn.dataset.pinned = String(pinned)
    btn.title = pinned ? (btn.dataset.unpinTitle ?? '') : (btn.dataset.pinTitle ?? '')
  }
  btn.addEventListener('click', () => {
    pinned = !pinned
    send(convId, tab, pinned)
    render()
  })
  render()
  return true
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bindFloatingStripPin(document), { once: true })
  } else {
    bindFloatingStripPin(document)
  }
}
