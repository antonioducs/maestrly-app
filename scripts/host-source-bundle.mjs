import path from 'node:path'
import { build } from 'esbuild'

// Resolve both workspace packages from source, regardless of stale dist output.
export function bundleHostSource(root, entry, options = {}) {
  return build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'bundle',
    alias: {
      '@maestrly/codex-client': path.join(root, 'packages/codex-client/src/index.ts'),
      '@maestrly/guest-transport': path.join(root, 'packages/guest-transport/src/index.ts'),
      '@maestrly/host-core': path.join(root, 'packages/host-core/src/index.ts'),
      '@maestrly/host-protocol': path.join(root, 'packages/host-protocol/src/index.ts'),
    },
    ...options,
  })
}
