import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { validateCodexRuntime } from '../../src/main/runtime-assets/codex-compatibility'
import { CodexReleaseStore } from '../../src/main/runtime-assets/codex-release-store'
import { compareStableVersions, discoverCodexRelease } from '../../src/main/runtime-assets/codex-releases'
import { CodexUpdateController } from '../../src/main/runtime-assets/codex-updates'
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

  it(
    'updates Codex to the latest official stable release, validates it, and rolls back without credentials',
    async () => {
      temporary ||= await mkdtemp(path.join(os.tmpdir(), 'maestrly-runtime-smoke-'))
      const userDataPath = path.join(temporary, 'codex-updates')
      let persisted: string | null = null
      const embedded = RUNTIME_ASSET_REGISTRY['codex-runtime']
      const store = new CodexReleaseStore({
        storage: {
          read: () => persisted,
          write: (value) => {
            persisted = value
          },
        },
        target: targetId,
        embedded,
      })
      const service = new RuntimeAssetService({
        userDataPath,
        acceptedDefinition: (id, version) => (id === 'codex-runtime' ? store.acceptedDefinition(version) : null),
      })
      const controller = new CodexUpdateController({
        service,
        store,
        target: targetId,
        embedded,
        discover: (target, signal) => discoverCodexRelease(target, signal),
        validate: (installationPath, definition, signal) => validateCodexRuntime(installationPath, definition, signal),
        log: (message, error) => console.warn(message, error),
      })

      const installed = await service.install('codex-runtime')
      expect(installed, installed.error).toMatchObject({ state: 'ready', version: embedded.version })
      const latest = await discoverCodexRelease(targetId)
      const snapshot = await controller.update()
      expect(snapshot.error).toBeUndefined()
      const active = await service.status('codex-runtime')
      if ((compareStableVersions(latest.version, embedded.version) ?? 0) <= 0) {
        expect(active.version).toBe(embedded.version)
        return
      }
      expect(active).toMatchObject({ state: 'ready', version: latest.version })
      const executable = path.join(active.path!, ...latest.targets[targetId]!.executablePath!.split('/'))
      expect((await run(executable, ['--version'], { timeout: 30_000 })).stdout.trim()).toBe(
        `codex-cli ${latest.version}`
      )

      // A restart with only persisted metadata recognizes the dynamic version offline.
      const restarted = new RuntimeAssetService({
        userDataPath,
        acceptedDefinition: (id, version) => (id === 'codex-runtime' ? store.acceptedDefinition(version) : null),
      })
      const lease = await restarted.acquireLease('codex-runtime')
      lease.release()

      expect(await controller.rollback()).toMatchObject({ availableVersion: latest.version })
      expect(await service.status('codex-runtime')).toMatchObject({ state: 'ready', version: embedded.version })
    },
    15 * 60_000
  )
})
