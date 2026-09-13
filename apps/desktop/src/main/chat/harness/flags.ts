import { getAppFlag } from '../../store'
import { harnessRegistry } from './catalog'

/**
 * Reads every flag declared by the catalog once, at admission. Execution helpers receive the
 * captured snapshot instead of rereading preferences, so toggling a flag never mutates a turn that
 * is already running and concurrent conversations cannot contaminate each other.
 */
export function captureHarnessFlags(): Readonly<Record<string, boolean>> {
  const flags: Record<string, boolean> = {}
  for (const profile of harnessRegistry().list()) {
    const flag = profile.definition.featureFlag
    if (flag) flags[flag.key] = getAppFlag(flag.key, flag.default)
  }
  return Object.freeze(flags)
}
