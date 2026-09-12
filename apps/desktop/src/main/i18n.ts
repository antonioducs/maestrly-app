/**
 * Main-process i18n wraps the pure shared/i18n core. Use stateless tFor(locale, ns) for dialogs,
 * errors, prompts, and MCP metadata. MCP resolves getLocale at handshake and prompts at spawn; dialogs
 * use tMain with the global locale updated at boot and settings:locale-set. Language changes affect
 * new sessions; ongoing sessions retain their starting locale.
 */
import { tFor, type Namespace, type SharedTFunc } from '../shared/i18n'
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/locale'

export { tFor }
export type { Namespace, SharedTFunc }

/**
 * Active main locale mirrors global UI for dialogs; MCP and prompts resolve from the store when
 * needed.
 */
let mainLocale: SupportedLocale = DEFAULT_LOCALE

/** Update main locale at boot after getLocale and on settings:locale-set. */
export function setMainLocale(locale: SupportedLocale): void {
  mainLocale = locale
}

/** Active main locale, defaulting to English until boot resolves the store. */
export function getMainLocale(): SupportedLocale {
  return mainLocale
}

/** Translation function fixed to the active main locale and namespace for native dialogs. */
export function tMain(ns: Namespace): SharedTFunc {
  return tFor(mainLocale, ns)
}
