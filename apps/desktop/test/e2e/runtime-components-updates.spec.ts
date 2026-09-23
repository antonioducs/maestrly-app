import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

interface Api {
  getOnboardingDone(): Promise<boolean>
  setOnboardingDone(done: boolean): void
}

declare const window: { api: Api }

interface StubState {
  installed: string
  previous: string | null
  available: string | null
  rejected: string | null
  automatic: boolean
  restartRequired: boolean
  lastCheckedAt: string | null
  error: string | null
  updateState: string | null
  bytesDownloaded: number | null
  nextCheckFails: boolean
  nextValidationFails: boolean
  cancelRequested: boolean
  releaseDownload: (() => void) | null
  calls: string[]
}

let userDataDir: string
let app: ElectronApplication | null = null

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'maestrly-e2e-runtime-updates-'))
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  await removeTempDirEventually(userDataDir)
})

test('manages independent Codex runtime updates without marking the installation broken', async ({
  browserName: _browserName,
}, testInfo) => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: `runtime-updates-${Date.now()}`,
      AGENTS_USERDATA: userDataDir,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
    },
  })
  const win = await app.firstWindow()
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  if (!(await win.evaluate(() => window.api.getOnboardingDone()))) {
    await win.evaluate(() => window.api.setOnboardingDone(true))
    const skip = win.getByRole('button', { name: 'Skip' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
  }

  // Synthetic release channel: the renderer talks to the real preload/IPC surface, the main-process handlers
  // are replaced by a deterministic state machine (no network, no downloads, no Codex process).
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const state: StubState = {
      installed: '0.155.1',
      previous: null,
      available: null,
      rejected: null,
      automatic: false,
      restartRequired: false,
      lastCheckedAt: null,
      error: null,
      updateState: null,
      bytesDownloaded: null,
      nextCheckFails: true,
      nextValidationFails: false,
      cancelRequested: false,
      releaseDownload: null,
      calls: [],
    }
    ;(globalThis as typeof globalThis & { __runtimeUpdates: StubState }).__runtimeUpdates = state
    const codex = () => ({
      id: 'codex-runtime',
      displayName: 'Codex runtime',
      requiredBy: 'Codex',
      availableVersion: '0.155.1',
      downloadBytes: 130_000_000,
      unpackedBytes: 320_000_000,
      status: { id: 'codex-runtime', state: 'ready', version: state.installed, diskUsageBytes: 320_000_000 },
      update: {
        state:
          state.updateState ??
          (state.error ? 'failed' : state.available ? 'available' : state.lastCheckedAt ? 'up-to-date' : 'idle'),
        automatic: state.automatic,
        restartRequired: state.restartRequired,
        ...(state.available ? { availableVersion: state.available } : {}),
        ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
        ...(state.error ? { error: state.error } : {}),
        ...(state.bytesDownloaded === null ? {} : { bytesDownloaded: state.bytesDownloaded, totalBytes: 100 }),
        ...(state.previous ? { rollbackVersion: state.previous } : {}),
        ...(state.rejected && state.rejected === state.available ? { rejectedVersion: state.rejected } : {}),
      },
    })
    const other = (id: string) => ({
      id,
      displayName: id,
      requiredBy: 'test',
      availableVersion: '1.0.0',
      downloadBytes: 1_000_000,
      unpackedBytes: 2_000_000,
      status: { id, state: 'not-installed', diskUsageBytes: 0 },
    })
    const emit = () => BrowserWindow.getAllWindows()[0]?.webContents.send('runtime-assets:changed', codex())
    // Production publishes a throttled, freshly computed snapshot after every operation settles; progress events
    // may otherwise arrive after the invoke reply.
    const settled = () => {
      setTimeout(emit, 50)
      return codex()
    }
    const replace = (channel: string, handler: (...args: never[]) => unknown) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler as (...args: unknown[]) => unknown)
    }
    replace('runtime-assets:list', () => [
      codex(),
      other('github-copilot-runtime'),
      other('tunnel-client'),
      other('local-ml-runtime'),
    ])
    replace('runtime-assets:status', (_event, id: string) => (id === 'codex-runtime' ? codex() : other(id)))
    replace('runtime-assets:check-update', () => {
      state.calls.push('check')
      state.error = state.nextCheckFails ? 'check-failed' : null
      if (!state.nextCheckFails) {
        state.available = '0.156.0'
        state.lastCheckedAt = '2026-09-22T17:30:00.000Z'
      }
      state.nextCheckFails = false
      return codex()
    })
    replace('runtime-assets:update', async () => {
      state.calls.push('update')
      state.error = null
      state.updateState = 'downloading'
      state.bytesDownloaded = 40
      emit()
      if (!state.nextValidationFails) {
        await new Promise<void>((resolve) => {
          state.releaseDownload = resolve
        })
      }
      state.releaseDownload = null
      state.bytesDownloaded = null
      if (state.cancelRequested) {
        state.cancelRequested = false
        state.updateState = null
        state.error = 'cancelled'
        return settled()
      }
      state.updateState = 'validating'
      emit()
      state.updateState = null
      if (state.nextValidationFails) {
        state.nextValidationFails = false
        state.error = 'incompatible'
        state.rejected = state.available
        return settled()
      }
      state.previous = state.installed
      state.installed = state.available ?? state.installed
      state.available = null
      state.rejected = null
      state.restartRequired = true
      return settled()
    })
    replace('runtime-assets:cancel', () => {
      state.calls.push('cancel')
      state.cancelRequested = true
      state.releaseDownload?.()
      return true
    })
    replace('runtime-assets:set-auto-update', (_event, _id: string, enabled: boolean) => {
      state.calls.push(`automatic:${enabled}`)
      state.automatic = enabled
      return codex()
    })
    replace('runtime-assets:rollback', () => {
      state.calls.push('rollback')
      if (state.previous) {
        state.rejected = state.installed
        state.available = state.installed
        state.installed = state.previous
        state.previous = null
        state.restartRequired = true
      }
      return settled()
    })
    for (const family of ['codex', 'claude', 'github-copilot', 'grok']) {
      replace(`chat:${family}-subscription:status`, () => ({ state: 'signed-out', authenticated: false }))
    }
    replace('chat:models', () => [])
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 960)
  })
  await win.reload()
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  const stub = () =>
    app!.evaluate(() => {
      const state = (globalThis as typeof globalThis & { __runtimeUpdates: StubState }).__runtimeUpdates
      return { calls: [...state.calls], downloading: state.releaseDownload !== null }
    })

  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await win.getByRole('tab', { name: 'Components', exact: true }).click()
  const codexCard = win.locator('[data-runtime-asset="codex-runtime"]')
  await expect(codexCard).toContainText('Installed v0.155.1')
  await expect(codexCard).toContainText('Not checked yet')
  await expect(codexCard.getByRole('checkbox', { name: /Update automatically/ })).not.toBeChecked()

  // A failed check reports a release-channel error while the installation itself stays Ready.
  await codexCard.getByRole('button', { name: 'Check for updates' }).click()
  await expect(codexCard).toContainText('Could not check for updates. The installed version keeps working.')
  await expect(codexCard).toContainText('Required by Codex · Ready')
  await expect(codexCard.getByRole('button', { name: /Repair|Retry/ })).toHaveCount(0)

  await codexCard.getByRole('button', { name: 'Check for updates' }).click()
  await expect(codexCard).toContainText('v0.156.0 available')
  await expect(codexCard).toContainText('Last checked')

  // Cancellation during the download.
  await codexCard.getByRole('button', { name: 'Update to v0.156.0' }).click()
  await expect(codexCard).toContainText('Downloading update')
  await expect(codexCard.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
  await expect(codexCard.getByRole('button', { name: 'Remove' })).toBeDisabled()
  await codexCard.getByRole('button', { name: 'Cancel' }).click()
  await expect(codexCard).toContainText('Update cancelled.')
  await expect(codexCard).toContainText('Installed v0.155.1')

  // A candidate that fails the compatibility test is not activated and is skipped by automatic updates.
  await app.evaluate(() => {
    ;(globalThis as typeof globalThis & { __runtimeUpdates: StubState }).__runtimeUpdates.nextValidationFails = true
  })
  await codexCard.getByRole('button', { name: 'Update to v0.156.0' }).click()
  await expect(codexCard).toContainText('This version did not pass the compatibility test and was not activated.')
  await expect(codexCard).toContainText('Automatic updates skip this version')
  await expect(codexCard).toContainText('Installed v0.155.1')

  // Explicit retry succeeds; open conversations keep the old version until restart.
  await codexCard.getByRole('button', { name: 'Update to v0.156.0' }).click()
  await expect.poll(async () => (await stub()).downloading).toBe(true)
  await app.evaluate(() => {
    ;(globalThis as typeof globalThis & { __runtimeUpdates: StubState }).__runtimeUpdates.releaseDownload?.()
  })
  await expect(codexCard).toContainText('Installed v0.156.0')
  await expect(codexCard).toContainText('Restart Maestrly to use the new version')
  await expect(codexCard.getByRole('button', { name: 'Go back to v0.155.1' })).toBeVisible()

  await codexCard.getByRole('checkbox', { name: /Update automatically/ }).check()
  await expect(codexCard.getByRole('checkbox', { name: /Update automatically/ })).toBeChecked()

  await win.waitForTimeout(1_000)
  await win.screenshot({ path: testInfo.outputPath('runtime-components-updates.png') })

  win.once('dialog', (dialog) => void dialog.accept())
  await codexCard.getByRole('button', { name: 'Go back to v0.155.1' }).click()
  await expect(codexCard).toContainText('Installed v0.155.1')
  await expect(codexCard).toContainText('v0.156.0 available')
  await expect(codexCard).toContainText('Automatic updates skip this version')

  expect((await stub()).calls).toEqual([
    'check',
    'check',
    'update',
    'cancel',
    'update',
    'update',
    'automatic:true',
    'rollback',
  ])
})
