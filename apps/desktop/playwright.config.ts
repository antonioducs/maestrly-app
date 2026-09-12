import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

// Repository fixtures must not inherit host Git filters, signing, or line-ending conversion.
process.env.GIT_CONFIG_GLOBAL = fileURLToPath(new URL('./test/fixtures/empty.gitconfig', import.meta.url))
process.env.GIT_CONFIG_NOSYSTEM = '1'

/** Electron integration tests use isolated profiles and a built application in out/. */
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000, // Leave time for native MCP and panel initialization on CI workers.
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
})
