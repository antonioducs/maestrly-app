import type { UiPreferences } from '../shared/types'
export function applyTheme(theme: UiPreferences['theme']) {
  document.documentElement.dataset.theme = theme
}
