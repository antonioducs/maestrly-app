/** A mounted editor can defer navigation until its draft is saved or discarded. */
export const MAIN_NAVIGATION_EVENT = 'maestrly:before-main-navigation'

/**
 * What a navigation leaves: the whole view (`app`, the default), or only the editor of one settings section, such as
 * a dialog that closes or a form that collapses, while the rest of the view and its other drafts stay.
 */
export type MainNavigationScope = 'app' | 'section'

export interface MainNavigationDetail {
  proceed: () => void
  scope: MainNavigationScope
}

export function requestMainNavigation(proceed: () => void, scope: MainNavigationScope = 'app'): void {
  const event = new CustomEvent<MainNavigationDetail>(MAIN_NAVIGATION_EVENT, {
    cancelable: true,
    detail: { proceed, scope },
  })
  if (window.dispatchEvent(event)) proceed()
}
