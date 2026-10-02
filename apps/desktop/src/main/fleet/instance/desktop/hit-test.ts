/**
 * Pure hit testing for the bot's desktop: decides which window, view or window-manager decoration a pointer position
 * on display :0 lands on. Rectangle edges are inclusive at the left/top and exclusive at the right/bottom.
 */

/** Display :0 coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A WebContentsView inside a window, in display :0 coordinates. */
export interface HitView<T> {
  target: T
  bounds: Rect
}

export interface HitWindow<T> {
  kind: 'browser' | 'popup'
  id: number
  /** Outer rectangle including window-manager decorations (equal to `content` for the frameless browser). */
  frame: Rect
  content: Rect
  /** Views from topmost to bottom; a point in the content but in no view goes to `windowTarget`. */
  views: HitView<T>[]
  windowTarget: T
}

export type Hit<T> =
  /** `x`/`y` are relative to the hit view (or to the content for `windowTarget`). */
  | { kind: 'content'; window: HitWindow<T>; target: T; x: number; y: number }
  | { kind: 'close'; window: HitWindow<T> }
  /** `x`/`y` are relative to the frame origin, so the caller can drag the window by the grabbed point. */
  | { kind: 'titlebar'; window: HitWindow<T>; x: number; y: number }
  /** Other decorations (borders): ignored by the caller. */
  | { kind: 'frame'; window: HitWindow<T> }

/** Width of the close button area at the right end of a popup's title bar. */
export const POPUP_CLOSE_WIDTH = 24

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/** Windows ordered topmost first (popups newest first, then the browser). Returns null outside every window. */
export function hitTest<T>(windows: readonly HitWindow<T>[], x: number, y: number): Hit<T> | null {
  for (const window of windows) {
    if (contains(window.content, x, y)) {
      for (const view of window.views) {
        if (contains(view.bounds, x, y)) {
          return { kind: 'content', window, target: view.target, x: x - view.bounds.x, y: y - view.bounds.y }
        }
      }
      return { kind: 'content', window, target: window.windowTarget, x: x - window.content.x, y: y - window.content.y }
    }
    // Only popups carry decorations; the browser is frameless and has nothing but its content.
    if (window.kind !== 'popup' || !contains(window.frame, x, y)) continue
    const { frame, content } = window
    const inTitleBar = y < content.y
    if (!inTitleBar) return { kind: 'frame', window }
    if (x >= frame.x + frame.width - POPUP_CLOSE_WIDTH) return { kind: 'close', window }
    return { kind: 'titlebar', window, x: x - frame.x, y: y - frame.y }
  }
  return null
}

/** Moves a popup frame by (dx, dy) keeping it entirely inside `bounds` (the browser content); returns the new frame origin. */
export function constrainFrame(frame: Rect, dx: number, dy: number, bounds: Rect): { x: number; y: number } {
  // A frame larger than the bounds is pinned to their top left corner.
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max))
  return {
    x: clamp(frame.x + dx, bounds.x, bounds.x + bounds.width - frame.width),
    y: clamp(frame.y + dy, bounds.y, bounds.y + bounds.height - frame.height),
  }
}
