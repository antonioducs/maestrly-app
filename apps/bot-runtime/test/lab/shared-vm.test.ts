import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
const execute = promisify(execFile)
test.skipIf(process.env.MAESTRLY_BOT_SHARED_LAB_TEST !== '1')(
  'two authenticated bots on the selected mini VM deliver distinct desktop captures', async () => {
    const result = await execute(process.execPath, ['scripts/bot-lab.mjs', 'sessions', '--authorize-bot-smoke'], {
      cwd: fileURLToPath(new URL('../../../../../', import.meta.url)), timeout: 16 * 60_000, maxBuffer: 1024 * 1024,
    })
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('captured')
    expect(report.captures).toHaveLength(2)
    expect(report.providerTurnsSucceeded).toBe(true)
    // Captures still require visual inspection, not a success claim from provider text alone.
    expect(report.visualReviewRequired).toBe(true)
  }, 17 * 60_000)
