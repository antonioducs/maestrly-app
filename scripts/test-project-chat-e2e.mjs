#!/usr/bin/env node
// Reuse the isolated Postgres/API/web lifecycle and OAuth fixture from the Kanban integration harness.
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['scripts/test-kanban-e2e.mjs'], {
  env: { ...process.env, MAESTRLY_DESKTOP_E2E: 'only', MAESTRLY_PROJECT_CHAT_E2E: '1' },
  stdio: 'inherit',
  shell: false,
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
