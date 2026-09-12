import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Unit and contract tests run in Node with real SQLite and explicit desktop runtime stubs. */
const here = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    // Provider contract suites load native-sized SDK graphs; bound memory on developer and CI machines.
    maxWorkers: process.platform === 'win32' ? 2 : 4,
    // Shared CI runners perform real Git and filesystem operations substantially slower than local hosts.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
    include: ['test/unit/**/*.test.ts'],
    setupFiles: [here('./test/setup.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Coverage thresholds apply to core persistence modules.
      include: [
        'src/main/store.ts',
        'src/main/store/**',
      ],
      thresholds: { lines: 70 },
    },
  },
  resolve: {
    alias: {
      electron: here('./test/stubs/electron.ts'),
      'node-pty': here('./test/stubs/node-pty.ts'),
      '@xenova/transformers': here('./test/stubs/transformers.ts'),
      '@xterm/headless': here('./test/stubs/xterm-headless.ts'),
    },
  },
})
