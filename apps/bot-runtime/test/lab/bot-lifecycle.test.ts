import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
const execute = promisify(execFile)
// Explicit double opt-in: environment flag plus the private lab config's authorizeBotSmoke flag.
// The script independently checks Host identity, the explicitly selected VM and the bot's readiness.
// This is the only place a real provider account and the Mac mini are exercised; PR checks never set it.
test.skipIf(process.env.MAESTRLY_BOT_LAB_TEST !== '1')(
  'real bot on the selected Mac mini: task delegated by chat produces a verifiable file',
  async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const result = await execute(process.execPath, ['scripts/bot-lab.mjs', 'smoke', '--authorize-bot-smoke'], {
      cwd: root,
      timeout: 900_000,
      maxBuffer: 1024 * 1024,
    })
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('supported')
    expect(report.fileProduced).toBe(true)
  },
  910_000
)
