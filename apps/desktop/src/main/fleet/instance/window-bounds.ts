/** A bot's primary browser uses its whole virtual screen; other floating windows retain their saved bounds. */
export function initialFloatingBounds<T>(
  tab: string,
  botMode: boolean,
  primaryWorkArea: T,
  saved: T | undefined
): T | undefined {
  return botMode && tab === 'browser' ? primaryWorkArea : saved
}
