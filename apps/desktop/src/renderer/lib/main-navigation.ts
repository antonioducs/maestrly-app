/** A mounted editor can defer navigation until its draft is saved or discarded. */
export const MAIN_NAVIGATION_EVENT = 'maestrly:before-main-navigation'

export function requestMainNavigation(proceed: () => void): void {
  const event = new CustomEvent<{ proceed: () => void }>(MAIN_NAVIGATION_EVENT, {
    cancelable: true,
    detail: { proceed },
  })
  if (window.dispatchEvent(event)) proceed()
}
