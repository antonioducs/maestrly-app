import { createHarnessRegistry } from './registry'
import type { HarnessRegistry, HarnessSources } from './types'

/**
 * Automatic discovery: every folder under `profiles/` is picked up by the bundler and inlined as
 * text. Adding a model means adding a folder — there is no manual list, import or enum to update.
 */
const modules = import.meta.glob<string>(['./profiles/*/config.json', './profiles/*/*.md'], {
  eager: true,
  query: '?raw',
  import: 'default',
})

function normalizeKey(path: string): string {
  return path.replace(/^\.\//, '')
}

export function harnessCatalogSources(): HarnessSources {
  const sources: Record<string, string> = {}
  for (const path of Object.keys(modules).sort()) {
    sources[normalizeKey(path)] = modules[path]!
  }
  return sources
}

let cached: HarnessRegistry | null = null

/** Immutable, process-wide catalog. Parsing and validation live in the pure registry module. */
export function harnessRegistry(): HarnessRegistry {
  cached ??= createHarnessRegistry(harnessCatalogSources())
  return cached
}
