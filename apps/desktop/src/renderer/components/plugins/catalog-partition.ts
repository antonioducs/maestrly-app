import { isBlockingReason, type PluginCatalogEntryDto, type PluginReason } from '../../../shared/plugins'

export interface IncompatibleEntry {
  entry: PluginCatalogEntryDto
  /** Why it is not offered: its first blocking reason (or its first reason when none blocks). */
  reason: PluginReason
}

/**
 * Splits a catalog into the plugins Maestrly offers and those it leaves out because they do not work the same with every
 * model. An external plugin not inspected yet (no compatibility) is offered; its details check it before any install.
 */
export function partitionCatalog(entries: readonly PluginCatalogEntryDto[]): {
  offered: PluginCatalogEntryDto[]
  incompatible: IncompatibleEntry[]
} {
  const offered: PluginCatalogEntryDto[] = []
  const incompatible: IncompatibleEntry[] = []
  for (const entry of entries) {
    if (entry.policy.installation === 'NOT_AVAILABLE') {
      incompatible.push({ entry, reason: { code: 'install-not-available' } })
      continue
    }
    const compatibility = entry.compatibility
    if (!compatibility || compatibility.level === 'portable') {
      offered.push(entry)
      continue
    }
    const reason = compatibility.reasons.find((item) => isBlockingReason(item.code)) ?? compatibility.reasons[0]
    incompatible.push({ entry, reason: reason ?? { code: 'no-usable-components' } })
  }
  return { offered, incompatible }
}
