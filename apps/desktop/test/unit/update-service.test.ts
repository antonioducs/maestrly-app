import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The fake updater is hoisted with the mock factory: `vi.mock` runs before the module imports, so it
// cannot close over an ordinary top-level constant.
const { fake } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class FakeUpdater extends EventEmitter {
    autoDownload = true
    autoInstallOnAppQuit = false
    allowPrerelease = true
    logger: unknown = null
    setFeedURL = vi.fn()
    checkForUpdates = vi.fn(async () => {
      this.emit('checking-for-update')
      this.emit('update-available', { version: '9.9.9', releaseNotes: 'notes' })
      return null
    })
    downloadUpdate = vi.fn(async () => {
      this.emit('download-progress', { percent: 42 })
      this.emit('update-downloaded', { version: '9.9.9' })
      return []
    })
    quitAndInstall = vi.fn()
  }
  return { fake: new FakeUpdater() }
})
vi.mock('electron-updater', () => ({ default: { autoUpdater: fake } }))

const settings = new Map<string, string>()
vi.mock('../../src/main/store', () => ({
  getAppSetting: (k: string) => settings.get(k) ?? null,
  setAppSetting: (k: string, v: string) => void settings.set(k, v),
}))
const broadcast = vi.fn()
vi.mock('../../src/main/window-ipc', () => ({ broadcast: (...a: unknown[]) => broadcast(...a) }))
let channel = 'prod'
vi.mock('../../src/main/channel', () => ({ getChannel: () => channel }))
vi.mock('../../src/main/test-mode', () => ({ isE2E: () => false }))

import { app, net, shell } from 'electron'
import * as svc from '../../src/main/update-service'

describe('update-service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    settings.clear()
    broadcast.mockClear()
    fake.removeAllListeners()
    fake.checkForUpdates.mockClear()
    fake.downloadUpdate.mockClear()
    fake.setFeedURL.mockClear()
    fake.quitAndInstall.mockClear()
    ;(app as { isPackaged: boolean }).isPackaged = true
    channel = 'prod'
    delete process.env.APPIMAGE
    delete process.env.AGENTS_UPDATE_FIXTURE
  })
  afterEach(() => {
    svc.disposeUpdateService()
    vi.useRealTimers()
  })

  it('is off outside packaged prod builds', () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    svc.configureUpdateService()
    expect(svc.getUpdateState()).toMatchObject({ mode: 'off', phase: 'idle' })
    channel = 'beta'
    ;(app as { isPackaged: boolean }).isPackaged = true
    svc.configureUpdateService()
    expect(svc.getUpdateState().mode).toBe('off')
  })

  it('installer mode: asks before downloading, then installs on restart', async () => {
    svc.configureUpdateService()
    expect(fake.autoDownload).toBe(false)
    expect(fake.allowPrerelease).toBe(false)
    expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'antonioducs', repo: 'maestrly-app' })
    await svc.checkForUpdates()
    expect(svc.getUpdateState()).toMatchObject({
      mode: 'installer',
      phase: 'available',
      availableVersion: '9.9.9',
      releaseNotes: 'notes',
    })
    expect(fake.downloadUpdate).not.toHaveBeenCalled()
    await svc.downloadUpdate()
    expect(svc.getUpdateState()).toMatchObject({ phase: 'downloaded', progressPercent: 100 })
    expect(broadcast).toHaveBeenCalledWith(
      'update:status',
      expect.objectContaining({ phase: 'downloading', progressPercent: 42 })
    )
    svc.installUpdate()
    expect(svc.isInstalling()).toBe(true)
    svc.finishInstall()
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('skips a version until a newer one shows up; manual check ignores the skip', async () => {
    svc.configureUpdateService()
    await svc.checkForUpdates()
    await svc.skipVersion()
    expect(settings.get(svc.UPDATE_SKIP_KEY)).toBe('9.9.9')
    expect(svc.getUpdateState().phase).toBe('idle')
    await svc.checkForUpdates()
    expect(svc.getUpdateState().phase).toBe('idle')
    await svc.checkForUpdates({ ignoreSkip: true })
    expect(svc.getUpdateState().phase).toBe('available')
    fake.checkForUpdates.mockImplementationOnce(async () => {
      fake.emit('update-available', { version: '10.0.0' })
      return null
    })
    await svc.checkForUpdates()
    expect(settings.get(svc.UPDATE_SKIP_KEY)).toBe('')
    expect(svc.getUpdateState().availableVersion).toBe('10.0.0')
  })

  it('checks 10 s after boot and every 6 h', () => {
    svc.configureUpdateService()
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6 * 60 * 60 * 1000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('records errors without throwing', async () => {
    svc.configureUpdateService()
    fake.checkForUpdates.mockImplementationOnce(async () => {
      fake.emit('error', new Error('offline'))
      return null
    })
    await expect(svc.checkForUpdates()).resolves.toMatchObject({ phase: 'error', error: 'offline' })
  })

  it('notify mode on linux without APPIMAGE uses the releases API and opens the page', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const fetch = vi.spyOn(net, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v9.9.9',
          body: 'notes',
          html_url: 'https://github.com/antonioducs/maestrly-app/releases/tag/v9.9.9',
          prerelease: false,
        })
      )
    )
    const open = vi.spyOn(shell, 'openExternal').mockResolvedValue()
    try {
      svc.configureUpdateService()
      expect(svc.getUpdateState().mode).toBe('notify')
      await svc.checkForUpdates()
      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/antonioducs/maestrly-app/releases/latest',
        expect.anything()
      )
      expect(svc.getUpdateState()).toMatchObject({
        phase: 'available',
        availableVersion: '9.9.9',
        releaseUrl: 'https://github.com/antonioducs/maestrly-app/releases/tag/v9.9.9',
      })
      await svc.openRelease()
      expect(open).toHaveBeenCalledWith('https://github.com/antonioducs/maestrly-app/releases/tag/v9.9.9')
    } finally {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      fetch.mockRestore()
      open.mockRestore()
    }
  })

  it('dev fixture simulates states without the real updater', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    channel = 'dev'
    process.env.AGENTS_UPDATE_FIXTURE = 'downloaded'
    svc.configureUpdateService()
    expect(svc.getUpdateState()).toMatchObject({
      mode: 'installer',
      phase: 'downloaded',
      availableVersion: '0.0.0-fixture',
    })
    expect(fake.setFeedURL).not.toHaveBeenCalled()
  })
})
