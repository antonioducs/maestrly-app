import type { Plugin } from 'vite'
import { harnessCatalogWatchPaths, validateHarnessCatalog } from './harness-catalog'

/**
 * Fails the build before a bundle is produced when a harness profile is invalid, and registers the
 * profile folders as watched dependencies so adding or removing one rebuilds the main process.
 */
export function harnessValidationPlugin(): Plugin {
  return {
    name: 'maestrly:harness-catalog',
    buildStart() {
      validateHarnessCatalog()
      for (const path of harnessCatalogWatchPaths()) this.addWatchFile(path)
    },
  }
}
