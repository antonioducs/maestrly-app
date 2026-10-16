/**
 * Whether the conversation offers a way back to its latest message. The list is inverted, so an offset of 0 is its
 * end: the button shows once the person has scrolled most of a screen, and at least 240 points, away from it.
 */
export function shouldOfferScrollToEnd(offsetY: number, viewportHeight: number): boolean {
  return offsetY > Math.max(240, viewportHeight * 0.75)
}
