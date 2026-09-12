import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { RUNTIME_ASSET_REGISTRY, hostRuntimeTarget } from '../../src/main/runtime-assets/registry'
import { RuntimeAssetService } from '../../src/main/runtime-assets/service'
import { RUNTIME_ASSET_IDS, type RuntimeAssetId } from '../../src/shared/runtime-assets'

const run = promisify(execFile)
const enabled = process.env.RUN_RUNTIME_ASSET_SMOKE === '1'
const suite = enabled ? describe : describe.skip
let temporary = ''

suite('managed provider runtime assets real smoke', () => {
  afterAll(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true })
  })

  const targetId = hostRuntimeTarget()
  const providerIds = RUNTIME_ASSET_IDS.filter((id) => id !== 'local-ml-runtime') as RuntimeAssetId[]
  for (const id of providerIds) {
    it(
      `installs, verifies and executes ${id} outside the app bundle`,
      async () => {
        temporary ||= await mkdtemp(path.join(os.tmpdir(), 'maestrly-runtime-smoke-'))
        const service = new RuntimeAssetService({ userDataPath: temporary })
        const installed = await service.install(id)
        expect(installed.state, installed.error).toBe('ready')
        const executablePath = RUNTIME_ASSET_REGISTRY[id].targets[targetId]?.executablePath
        expect(executablePath, `No executable smoke contract for ${id} on ${targetId}`).toBeTruthy()
        const executable = path.join(installed.path!, ...executablePath!.split('/'))
        const result = await run(executable, ['--version'], { timeout: 30_000 })
        expect(`${result.stdout}${result.stderr}`.trim()).not.toBe('')
        if (process.platform === 'darwin') {
          const signature = await run('/usr/bin/codesign', ['--verify', '--verbose=2', executable], {
            timeout: 30_000,
          }).catch((error: unknown) => ({ stderr: error instanceof Error ? error.message : String(error) }))
          expect(String(signature.stderr)).not.toMatch(/invalid signature|not signed at all/i)
        }
      },
      10 * 60_000
    )
  }
})
