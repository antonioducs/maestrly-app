import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test commits SQLite transactions and serves real HTTP; Windows CI runners sync to disk far more slowly.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
})
