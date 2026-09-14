import { defineConfig } from 'vitest/config'
// Recovery suites wait on real reconnect/reconcile delays; keep a generous per-test budget.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000 } })
