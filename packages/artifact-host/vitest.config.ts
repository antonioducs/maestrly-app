import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests serve real HTTP and run real SQLite; shared CI runners are slower than developer machines.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
})
