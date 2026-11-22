/** How close to the left edge, in points, a drag must start to open the menu. */
export const DRAWER_EDGE = 24

/**
 * Whether a horizontal drag should move the menu: closing it from anywhere, opening it only from the left edge, so
 * code blocks and tables in a conversation keep their own sideways scroll.
 */
export function shouldDragDrawer(open: boolean, gesture: { moveX: number; dx: number; dy: number }): boolean {
  const horizontal = Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
  if (!horizontal) return false
  if (open) return gesture.dx < 0
  // PanResponder fills x0 only once it grants the gesture, so before that the start is where the finger is now
  // minus how far it has moved.
  return gesture.dx > 0 && gesture.moveX - gesture.dx <= DRAWER_EDGE
}
