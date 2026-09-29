import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The runner syncs its journal to disk and runs real Git; shared CI runners, Windows above all, are much slower.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
})
