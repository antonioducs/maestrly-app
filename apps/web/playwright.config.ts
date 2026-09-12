import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  projects: [{ name: 'en', use: { locale: 'en-US' } }, { name: 'pt-BR', use: { locale: 'pt-BR' } }],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.MAESTRLY_WEB_URL ?? 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: process.env.MAESTRLY_E2E_EXTERNAL ? undefined : {
    command: 'npm run dev', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI,
  },
})
