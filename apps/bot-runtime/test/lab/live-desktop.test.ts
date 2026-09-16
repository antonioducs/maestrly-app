import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
const execute = promisify(execFile)
// Physical phase 3 laboratory on the selected Mac mini VM. Skipped unless explicitly enabled;
// the script additionally requires authorizeDesktopLab in the private lab configuration.
test.skipIf(process.env.MAESTRLY_BOT_DESKTOP_LAB_TEST !== '1')(
  'live desktop, takeover mid-task, hand-back and continuation through SSH and the Host', async () => {
    const result = await execute(process.execPath, ['scripts/bot-desktop-lab.mjs', 'run', '--authorize-desktop-lab'], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)), timeout: 20 * 60_000, maxBuffer: 1024 * 1024,
    }).catch((error) => error)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('supported')
    expect(report.checks).toMatchObject({ stream: true, twoClients: true, takeover: true, input: true, viewerDisconnect: true, leaseLoss: true, return: true, continuation: true })
    // Performance targets are reported against the plan, never inferred from functional success.
    expect(report.targetsMet).toBeDefined()
  }, 21 * 60_000)
