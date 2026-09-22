import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// The fake updater is hoisted with the mock factory: `vi.mock` runs before the module imports, so it
// cannot close over an ordinary top-level constant.
const { fake, nativeUpdater } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const nativeUpdater = new EventEmitter()
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
      nativeUpdater.emit('update-downloaded')
      return []
    })
    quitAndInstall = vi.fn()
  }
  return { fake: new FakeUpdater(), nativeUpdater }
})
vi.mock('electron-updater', () => ({ default: { autoUpdater: fake } }))
vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  autoUpdater: nativeUpdater,
}))

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
let svc: typeof import('../../src/main/update-service')

// The resolved mode depends on the host platform, so every case pins it explicitly: a Linux runner
// without $APPIMAGE would otherwise turn the installer cases into notify-only ones.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

/** Execute the actual shutdown registration without booting the desktop or its user profile. */
function quitHarness() {
  const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('let projectSetupsFlushed = false')
  expect(start).toBeGreaterThan(0)
  const shutdown = ts.transpileModule(source.slice(start), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const order: string[] = []
  const events: { prevented: boolean; preventDefault: () => void }[] = []
  let handler: (event: (typeof events)[number]) => void
  let pendingMemory = true
  const cleanup = vi.fn(() => order.push('cleanup'))
  const stopMlWorker = vi.fn()
  const stopAsrWorker = vi.fn()
  const confirmQuit = vi.fn(async () => true)
  const quit = vi.spyOn(app, 'quit').mockImplementation(() => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true
      },
    }
    events.push(event)
    handler(event)
  })
  runInNewContext(shutdown, {
    app: {
      on: (_name: string, callback: typeof handler) => {
        handler = callback
      },
      quit: () => app.quit(),
    },
    console,
    isE2E: () => false,
    isInstalling: svc.isInstalling,
    confirmQuit,
    cancelProjectSetupsAndWait: async () => {
      order.push('projects')
    },
    embeddedRunnerHost: {
      stop: async () => {
        order.push('runner')
      },
    },
    botHost: {
      stop: async () => {
        order.push('bot')
      },
    },
    disposeChat: async () => {
      order.push('chat')
    },
    disposeConversationMigrationIpc: null,
    releaseInstanceLock: cleanup,
    floatingManager: { flushPendingFloatPersists: vi.fn(), disposeAll: vi.fn() },
    popupManager: { disposeAll: vi.fn() },
    releasePowerBlocker: vi.fn(),
    killAllPtys: vi.fn(),
    stopVSCodeServer: vi.fn(),
    disposeDrawer: vi.fn(),
    disposeMemoryReclaimer: vi.fn(),
    disposeMemoryIndexService: vi.fn(),
    disposeOwnedProcesses: vi.fn(),
    hasPendingMemoryWrites: () => pendingMemory,
    flushPendingMemoryWrites: async () => {
      order.push('memory')
      pendingMemory = false
      return true
    },
    stopMlWorker,
    stopAsrWorker,
    disposeUpdateService: svc.disposeUpdateService,
    finishInstall: svc.finishInstall,
  })
  return { order, events, cleanup, stopMlWorker, stopAsrWorker, confirmQuit, restore: () => quit.mockRestore() }
}

describe('update-service', () => {
  beforeEach(async () => {
    vi.resetModules()
    svc = await import('../../src/main/update-service')
    setPlatform('darwin')
    vi.useFakeTimers()
    settings.clear()
    broadcast.mockClear()
    fake.removeAllListeners()
    nativeUpdater.removeAllListeners()
    fake.checkForUpdates.mockClear()
    fake.downloadUpdate.mockClear()
    fake.setFeedURL.mockClear()
    fake.quitAndInstall.mockReset()
    ;(app as { isPackaged: boolean }).isPackaged = true
    channel = 'prod'
    delete process.env.APPIMAGE
    delete process.env.AGENTS_UPDATE_FIXTURE
  })
  afterEach(() => {
    svc.disposeUpdateService()
    vi.useRealTimers()
  })
  afterAll(() => {
    if (hostPlatform) Object.defineProperty(process, 'platform', hostPlatform)
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
    svc.finishInstall(vi.fn())
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  async function prepareInstall(): Promise<void> {
    svc.configureUpdateService()
    await svc.checkForUpdates()
    await svc.downloadUpdate()
  }

  it.each(['darwin', 'win32', 'linux'] as const)(
    'holds the original quit until the installer owns it on %s',
    async (platform) => {
      setPlatform(platform)
      if (platform === 'linux') process.env.APPIMAGE = '/synthetic/Maestrly.AppImage'
      await prepareInstall()
      svc.installUpdate()
      const preventDefault = vi.fn()
      fake.quitAndInstall.mockImplementationOnce(() => {
        expect(preventDefault).toHaveBeenCalledOnce()
      })
      svc.finishInstall(preventDefault)
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(fake.quitAndInstall).toHaveBeenCalledOnce()

      // Another quit while Squirrel is preparing the downloaded ZIP must also wait.
      const repeatedQuit = vi.fn()
      svc.finishInstall(repeatedQuit)
      expect(repeatedQuit).toHaveBeenCalledOnce()
      expect(fake.quitAndInstall).toHaveBeenCalledOnce()

      nativeUpdater.emit('before-quit-for-update')
      const installerQuit = vi.fn()
      svc.finishInstall(installerQuit)
      expect(installerQuit).not.toHaveBeenCalled()
      expect(fake.quitAndInstall).toHaveBeenCalledOnce()
    }
  )

  it('allows an immediately ready installer to reenter the quit handler without recursion', async () => {
    await prepareInstall()
    svc.installUpdate()
    const originalQuit = vi.fn()
    const installerQuit = vi.fn()
    fake.quitAndInstall.mockImplementationOnce(() => {
      expect(originalQuit).toHaveBeenCalledOnce()
      nativeUpdater.emit('before-quit-for-update')
      svc.finishInstall(installerQuit)
    })
    svc.finishInstall(originalQuit)
    expect(originalQuit).toHaveBeenCalledOnce()
    expect(fake.quitAndInstall).toHaveBeenCalledOnce()
    expect(installerQuit).not.toHaveBeenCalled()
  })

  it('ignores repeated install clicks while handing off', async () => {
    await prepareInstall()
    const quit = vi.spyOn(app, 'quit')
    try {
      svc.installUpdate()
      svc.finishInstall(vi.fn())
      svc.installUpdate()
      expect(quit).toHaveBeenCalledOnce()
      expect(fake.quitAndInstall).toHaveBeenCalledOnce()
    } finally {
      quit.mockRestore()
    }
  })

  it.each(['throw', 'event'] as const)('reports an installation %s and permits a new attempt', async (failure) => {
    await prepareInstall()
    svc.installUpdate()
    fake.quitAndInstall.mockImplementationOnce(() => {
      if (failure === 'throw') throw new Error('installation failed')
    })
    const prevented = vi.fn()
    svc.finishInstall(prevented)
    if (failure === 'event') {
      expect(() => fake.emit('error', new Error('installation failed'))).not.toThrow()
    }
    expect(prevented).toHaveBeenCalledOnce()
    expect(svc.getUpdateState()).toMatchObject({ phase: 'error', error: 'installation failed' })
    expect(svc.isInstalling()).toBe(false)

    await svc.checkForUpdates()
    await svc.downloadUpdate()
    svc.installUpdate()
    svc.finishInstall(vi.fn())
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(2)
  })

  it('does not intercept a normal quit or invoke the installer', async () => {
    await prepareInstall()
    const prevented = vi.fn()
    svc.finishInstall(prevented)
    expect(prevented).not.toHaveBeenCalled()
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
  })

  it('waits for native macOS readiness before allowing teardown, even after downloadUpdate resolves', async () => {
    svc.configureUpdateService()
    await svc.checkForUpdates()
    fake.downloadUpdate.mockImplementationOnce(async () => {
      fake.emit('update-downloaded', { version: '9.9.9' })
      return []
    })
    await svc.downloadUpdate()
    expect(svc.getUpdateState()).toMatchObject({ phase: 'downloading', progressPercent: 100 })
    const quit = vi.spyOn(app, 'quit')
    try {
      svc.installUpdate()
      expect(quit).not.toHaveBeenCalled()
      nativeUpdater.emit('update-downloaded')
      expect(svc.getUpdateState().phase).toBe('downloaded')
      svc.installUpdate()
      expect(quit).toHaveBeenCalledOnce()
    } finally {
      quit.mockRestore()
    }
  })

  it('keeps the app alive on a native preparation error and can download again', async () => {
    svc.configureUpdateService()
    await svc.checkForUpdates()
    fake.downloadUpdate.mockImplementationOnce(async () => {
      fake.emit('update-downloaded', { version: '9.9.9' })
      return []
    })
    await svc.downloadUpdate()
    fake.emit('error', new Error('native preparation failed'))
    nativeUpdater.emit('update-downloaded')
    expect(svc.getUpdateState()).toMatchObject({ phase: 'error', error: 'native preparation failed' })
    expect(svc.isInstalling()).toBe(false)
    await svc.checkForUpdates()
    await svc.downloadUpdate()
    expect(svc.getUpdateState().phase).toBe('downloaded')
  })

  it.each([false, true])(
    'the real quit handler cleans up once before installer handoff (immediate=%s)',
    async (immediate) => {
      await prepareInstall()
      const harness = quitHarness()
      fake.quitAndInstall.mockImplementationOnce(() => {
        harness.order.push('install')
        if (immediate) {
          nativeUpdater.emit('before-quit-for-update')
          app.quit()
        }
      })
      try {
        svc.installUpdate()
        // Drain the bounded project, runner, chat and memory promise chain.
        for (let i = 0; i < 30; i++) await Promise.resolve()
        expect(fake.quitAndInstall).toHaveBeenCalledOnce()
        expect(harness.order).toEqual(['projects', 'runner', 'bot', 'chat', 'cleanup', 'memory', 'install'])
        expect(harness.cleanup).toHaveBeenCalledOnce()
        if (!immediate) {
          expect(harness.events.every((event) => event.prevented)).toBe(true)
          app.quit()
          expect(harness.events.at(-1)?.prevented).toBe(true)
          nativeUpdater.emit('before-quit-for-update')
          app.quit()
        }
        expect(harness.events.at(-1)?.prevented).toBe(false)
        expect(harness.cleanup).toHaveBeenCalledOnce()
        expect(fake.quitAndInstall).toHaveBeenCalledOnce()
        expect(harness.stopMlWorker).toHaveBeenCalledOnce()
        expect(harness.stopAsrWorker).toHaveBeenCalledOnce()
      } finally {
        harness.restore()
      }
    }
  )

  it('the real quit handler retains error listeners while the installer is pending', async () => {
    await prepareInstall()
    const harness = quitHarness()
    try {
      svc.installUpdate()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(() => fake.emit('error', new Error('handoff failed'))).not.toThrow()
      expect(svc.getUpdateState()).toMatchObject({ phase: 'error', error: 'handoff failed' })
      expect(svc.isInstalling()).toBe(false)
      await svc.checkForUpdates()
      await svc.downloadUpdate()
      svc.installUpdate()
      expect(fake.quitAndInstall).toHaveBeenCalledTimes(2)
      expect(harness.cleanup).toHaveBeenCalledOnce()
    } finally {
      harness.restore()
    }
  })

  it('releases the quit guard when the installer silently declines the handoff', async () => {
    await prepareInstall()
    const harness = quitHarness()
    try {
      svc.installUpdate()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(harness.events.at(-1)?.prevented).toBe(true)
      vi.advanceTimersByTime(30_000)
      expect(svc.getUpdateState()).toMatchObject({ phase: 'error' })
      expect(svc.isInstalling()).toBe(false)
      app.quit()
      expect(harness.confirmQuit).not.toHaveBeenCalled()
      expect(harness.events.at(-1)?.prevented).toBe(false)
    } finally {
      harness.restore()
    }
  })

  it('clears the handoff deadline when the installer owns the exit', async () => {
    await prepareInstall()
    svc.installUpdate()
    svc.finishInstall(vi.fn())
    nativeUpdater.emit('before-quit-for-update')
    vi.advanceTimersByTime(30_000)
    expect(svc.getUpdateState().phase).toBe('downloaded')
    expect(svc.isInstalling()).toBe(true)
  })

  it.each(['normal', 'fixture'])('the real quit handler preserves %s exit', async (mode) => {
    if (mode === 'fixture') {
      channel = 'dev'
      process.env.AGENTS_UPDATE_FIXTURE = 'downloaded'
    }
    svc.configureUpdateService()
    const harness = quitHarness()
    try {
      if (mode === 'fixture') svc.installUpdate()
      else app.quit()
      for (let i = 0; i < 30; i++) await Promise.resolve()
      expect(harness.events.at(-1)?.prevented).toBe(false)
      expect(harness.cleanup).toHaveBeenCalledOnce()
      expect(harness.stopMlWorker).toHaveBeenCalledOnce()
      expect(harness.stopAsrWorker).toHaveBeenCalledOnce()
      expect(fake.quitAndInstall).not.toHaveBeenCalled()
      expect(nativeUpdater.listenerCount('update-downloaded')).toBe(0)
    } finally {
      harness.restore()
    }
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
    setPlatform('linux')
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
    svc.installUpdate()
    const prevented = vi.fn()
    svc.finishInstall(prevented)
    expect(prevented).not.toHaveBeenCalled()
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
  })
})
