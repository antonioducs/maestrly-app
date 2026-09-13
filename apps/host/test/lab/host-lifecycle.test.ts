import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
const execute = promisify(execFile)
// Explicit double opt-in: environment flag plus the private lab config's
// authorizeSmoke flag. The script independently checks Host identity and caps.
test.skipIf(process.env.MAESTRLY_HOST_LAB_TEST !== '1')(
  'packaged Mac mini lifecycle and synced marker persistence',
  async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const result = await execute(process.execPath, ['scripts/host-lab.mjs', 'smoke', '--authorize-smoke'], {
      cwd: root,
      timeout: 900_000,
      maxBuffer: 1024 * 1024,
    })
    expect(JSON.parse(result.stdout).status).toBe('supported')
  },
  910_000
)
