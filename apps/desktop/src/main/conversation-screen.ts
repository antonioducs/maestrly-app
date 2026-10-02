/**
 * Screens that belong to single conversations. In a bot environment each bot conversation has its own X display for
 * desktop apps (`computer_*` tools) and an area of the shared Electron display that holds its browser and other
 * windows. Conversations without a registration keep using the primary display, as before.
 */

export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

export interface ConversationScreen {
  /** X display of the conversation's apps screen, such as `:2`. */
  display: string
  /** Size of that display in pixels. */
  width: number
  height: number
  /** Area of the Electron display that holds the conversation's windows. */
  windowArea: ScreenArea
}

export type ConversationScreenListener = (conversationId: string, screen: ConversationScreen | null) => void

// An X display name: optional host, display number and optional screen number. It is passed to child processes
// as an argument or DISPLAY value, so anything else is refused.
const displayPattern = /^[A-Za-z0-9._-]*:\d{1,5}(?:\.\d{1,3})?$/
const screens = new Map<string, ConversationScreen>()
const listeners = new Set<ConversationScreenListener>()

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0

function isValidScreen(screen: ConversationScreen): boolean {
  const area = screen.windowArea
  return (
    typeof screen.display === 'string' &&
    displayPattern.test(screen.display) &&
    isPositiveInteger(screen.width) &&
    isPositiveInteger(screen.height) &&
    !!area &&
    Number.isSafeInteger(area.x) &&
    Number.isSafeInteger(area.y) &&
    isPositiveInteger(area.width) &&
    isPositiveInteger(area.height)
  )
}

function notify(conversationId: string, screen: ConversationScreen | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(conversationId, screen)
    } catch (error) {
      console.error('A conversation screen listener failed:', error instanceof Error ? error.message : String(error))
    }
  }
}

/** Register the screen of a conversation, or clear it with `null`. Invalid screens throw and change nothing. */
export function setConversationScreen(conversationId: string, screen: ConversationScreen | null): void {
  if (!conversationId) throw new TypeError('A conversation screen needs a conversation id.')
  if (screen === null) {
    if (screens.delete(conversationId)) notify(conversationId, null)
    return
  }
  if (!isValidScreen(screen)) throw new TypeError(`Invalid screen for conversation ${conversationId}.`)
  const { x, y, width, height } = screen.windowArea
  const registered: ConversationScreen = Object.freeze({
    display: screen.display,
    width: screen.width,
    height: screen.height,
    windowArea: Object.freeze({ x, y, width, height }),
  })
  screens.set(conversationId, registered)
  notify(conversationId, registered)
}

/** The registered screen of a conversation, or `null` when it uses the primary display. */
export function conversationScreen(conversationId: string | undefined): ConversationScreen | null {
  return conversationId ? (screens.get(conversationId) ?? null) : null
}

/** Observe registrations and removals; returns the function that stops observing. */
export function onConversationScreenChange(listener: ConversationScreenListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The size of a conversation's browser window when its bot's desktop presents it (a unified bot desktop). The window
 * then sits at the top left of the conversation's window area at this size, without an identity strip, and its popups
 * open inside it. Changing it notifies the screen listeners, so the windows move at once.
 */
const presentedSizes = new Map<string, { width: number; height: number }>()

export function setPresentedBrowserSize(conversationId: string, size: { width: number; height: number } | null): void {
  if (!conversationId) throw new TypeError('A presented browser needs a conversation id.')
  if (size === null) {
    if (!presentedSizes.delete(conversationId)) return
  } else {
    if (!isPositiveInteger(size.width) || !isPositiveInteger(size.height))
      throw new TypeError(`Invalid presented browser size for conversation ${conversationId}.`)
    const current = presentedSizes.get(conversationId)
    if (current?.width === size.width && current.height === size.height) return
    presentedSizes.set(conversationId, Object.freeze({ width: size.width, height: size.height }))
  }
  notify(conversationId, screens.get(conversationId) ?? null)
}

/** The presented size of a conversation's browser, or null when its desktop does not present it. */
export function presentedBrowserSize(conversationId: string | undefined): { width: number; height: number } | null {
  return conversationId ? (presentedSizes.get(conversationId) ?? null) : null
}
