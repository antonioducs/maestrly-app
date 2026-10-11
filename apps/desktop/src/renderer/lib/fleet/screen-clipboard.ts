export type ScreenClipboardError = 'unsupportedText' | 'tooLarge' | 'writeFailed' | 'readFailed'
const MAX_TEXT_LENGTH = 1024 * 1024

/** Text clipboard bridge for a controlled noVNC canvas. No local clipboard polling. */
export function attachScreenClipboard(
  container: HTMLElement,
  remote: EventTarget & {
    clipboardPasteFrom(text: string): void
    sendKey(keysym: number, code: string, down?: boolean): void
  },
  writeText: (text: string) => Promise<void>,
  isMac: boolean,
  onError: (error: ScreenClipboardError | null) => void,
  readText: () => Promise<string>
): () => void {
  const doc = container.ownerDocument
  let connected = true
  let copyDeadline = 0
  let remoteText: string | null = null
  let shift = false
  let pasteGeneration = 0
  const held = new Map<string, number>()
  const modifiers: Record<string, number> = {
    ControlLeft: 0xffe3,
    ControlRight: 0xffe4,
    ShiftLeft: 0xffe1,
    ShiftRight: 0xffe2,
    // noVNC remaps the Mac's left Command to Alt, and right Command to Super.
    MetaLeft: isMac ? 0xffe9 : 0xffeb,
    MetaRight: isMac ? 0xffeb : 0xffec,
  }
  const focused = () =>
    connected && doc.visibilityState !== 'hidden' && doc.hasFocus() && container.contains(doc.activeElement)
  const write = (text: string) => {
    void writeText(text).catch(() => {
      if (connected) onError('writeFailed')
    })
  }
  const shortcut = (key: 'c' | 'x' | 'v', withShift = shift) => {
    // x11vnc may defer its first CLIPBOARD notification. Keep an explicit copy alive
    // while the user switches apps, but never carry it across a disconnected session.
    copyDeadline = key === 'v' ? 0 : Date.now() + 20_000
    // The fleet server uses -noprimary, so this cache holds CLIPBOARD, never a selection.
    // x11vnc suppresses unchanged notifications. Re-copying the same text must still
    // replace a local clipboard changed since the previous remote copy.
    if (key !== 'v' && remoteText !== null) write(remoteText)
    for (const [code, sym] of held) remote.sendKey(sym, code, false)
    remote.sendKey(0xffe3, 'ControlLeft', true)
    if (withShift) remote.sendKey(0xffe1, 'ShiftLeft', true)
    remote.sendKey(key.charCodeAt(0), `Key${key.toUpperCase()}`)
    if (withShift) remote.sendKey(0xffe1, 'ShiftLeft', false)
    remote.sendKey(0xffe3, 'ControlLeft', false)
    for (const [code, sym] of held) remote.sendKey(sym, code, true)
  }
  const keyboard = (event: KeyboardEvent) => {
    if (event.type === 'keyup') shift = false
    if (!focused()) return
    const sym = modifiers[event.code]
    if (sym) {
      if (event.type === 'keydown') held.set(event.code, sym)
      else held.delete(event.code)
    }
    const key = event.key.toLowerCase()
    if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || !['c', 'x', 'v'].includes(key)) return
    // Let Chromium dispatch native copy/cut/paste events, including clipboardData for paste,
    // before noVNC's keyboard handler can consume the shortcut.
    event.stopPropagation()
    if (event.type !== 'keydown') return
    shift = event.shiftKey
    // macOS has no default menu accelerator for Command+Shift+V.
    if (isMac && shift && key === 'v') {
      event.preventDefault()
      shift = false
      copyDeadline = 0
      if (!event.repeat) {
        const generation = ++pasteGeneration
        void readText()
          .then((text) => {
            if (generation === pasteGeneration && focused()) pasteText(text, true)
          })
          .catch(() => {
            if (generation === pasteGeneration && focused()) onError('readFailed')
          })
      }
      return
    }
    // Shift+Copy/Cut has no native Edit-menu action, but Linux terminals use it.
    if (shift && (key === 'c' || key === 'x')) {
      event.preventDefault()
      if (!event.repeat) {
        onError(null)
        shortcut(key)
      }
      shift = false
      return
    }
  }
  const copy = (event: ClipboardEvent) => {
    if (!focused()) return
    event.preventDefault()
    event.stopPropagation()
    onError(null)
    shortcut(event.type === 'cut' ? 'x' : 'c')
    shift = false
  }
  const pasteText = (text: string, withShift: boolean) => {
    // The fleet's x11vnc uses legacy Latin-1 cut text. noVNC silently replaces other
    // characters with '?'; refuse those pastes instead of changing commands or content.
    if (text.length > MAX_TEXT_LENGTH || /[^\u0000-\u00ff]/u.test(text)) {
      onError(text.length > MAX_TEXT_LENGTH ? 'tooLarge' : 'unsupportedText')
      return
    }
    onError(null)
    remote.clipboardPasteFrom(text)
    // x11vnc adopts pasted text as CLIPBOARD and suppresses unchanged notifications.
    remoteText = text
    shortcut('v', withShift)
  }
  const paste = (event: ClipboardEvent) => {
    const withShift = shift
    shift = false
    if (!focused()) return
    ++pasteGeneration
    copyDeadline = 0
    if (!event.clipboardData?.types.includes('text/plain')) return
    event.preventDefault()
    event.stopPropagation()
    pasteText(event.clipboardData.getData('text/plain'), withShift)
  }
  const clipboard = (event: Event) => {
    if (!connected) return
    const requested = Date.now() < copyDeadline
    const text: unknown = (event as CustomEvent<{ text: unknown }>).detail?.text
    if (typeof text !== 'string') return
    if (text.length > MAX_TEXT_LENGTH) {
      remoteText = null
      if (requested) onError('tooLarge')
      return
    }
    remoteText = text
    if (!requested) return
    copyDeadline = 0
    write(text)
  }
  const blur = () => {
    ++pasteGeneration
    held.clear()
    shift = false
  }
  const disconnect = () => {
    connected = false
    copyDeadline = 0
    remoteText = null
    blur()
  }
  container.addEventListener('keydown', keyboard, true)
  container.addEventListener('keyup', keyboard, true)
  container.addEventListener('copy', copy, true)
  container.addEventListener('cut', copy, true)
  container.addEventListener('paste', paste, true)
  container.addEventListener('focusout', blur)
  remote.addEventListener('clipboard', clipboard)
  remote.addEventListener('disconnect', disconnect)
  return () => {
    disconnect()
    container.removeEventListener('keydown', keyboard, true)
    container.removeEventListener('keyup', keyboard, true)
    container.removeEventListener('copy', copy, true)
    container.removeEventListener('cut', copy, true)
    container.removeEventListener('paste', paste, true)
    container.removeEventListener('focusout', blur)
    remote.removeEventListener('clipboard', clipboard)
    remote.removeEventListener('disconnect', disconnect)
  }
}
