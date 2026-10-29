import { describe, expect, it } from 'vitest'
import {
  defaultRunnerConfig,
  defaultRunnerExecutor,
  effectiveRunnerExecutor,
  nativeExecutorAllowed,
  readRunnerConfig,
  RUNNER_SETTING_KEYS,
  type RunnerSettingsStore,
  writeRunnerConfig,
} from '../../src/main/fleet/client/runner-settings'
import { GIB } from '../../src/shared/runner'

/** App settings in memory, the way the database keeps them: flags as 0 and 1, the rest as text. */
function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const store: RunnerSettingsStore = {
    getFlag: (key, fallback) => (values.has(key) ? values.get(key) === '1' : fallback),
    getSetting: (key) => values.get(key) ?? null,
    setFlag: (key, value) => void values.set(key, value ? '1' : '0'),
    setSetting: (key, value) => void values.set(key, value),
  }
  return { store, values }
}

describe('runner settings', () => {
  it('starts off, with one slot, no limits, no GPU, the default folder and a 50 GB blob cache', () => {
    const { store } = memoryStore()
    expect(readRunnerConfig(store, 'linux')).toEqual({
      enabled: false,
      executor: 'native',
      slots: 1,
      jobCpus: null,
      jobMemoryBytes: null,
      gpu: false,
      storageDir: null,
      blobCapBytes: 50 * GIB,
    })
    expect(readRunnerConfig(store, 'darwin').executor).toBe('native')
    expect(readRunnerConfig(store, 'win32').executor).toBe('container')
    expect(defaultRunnerConfig('win32').executor).toBe('container')
  })

  it('allows Native on macOS and Linux and never on Windows', () => {
    expect(nativeExecutorAllowed('darwin')).toBe(true)
    expect(nativeExecutorAllowed('linux')).toBe(true)
    expect(nativeExecutorAllowed('win32')).toBe(false)
    expect(defaultRunnerExecutor('win32')).toBe('container')
    expect(effectiveRunnerExecutor('native', 'win32')).toBe('container')
    expect(effectiveRunnerExecutor('native', 'linux')).toBe('native')
    expect(effectiveRunnerExecutor('container', 'linux')).toBe('container')
  })

  it('reads Container on Windows whatever was stored, and saves Container when Native is asked for', () => {
    const { store, values } = memoryStore({ [RUNNER_SETTING_KEYS.executor]: 'native' })
    expect(readRunnerConfig(store, 'win32').executor).toBe('container')
    expect(readRunnerConfig(store, 'linux').executor).toBe('native')
    expect(writeRunnerConfig(store, { executor: 'native' }, 'win32').executor).toBe('container')
    expect(values.get(RUNNER_SETTING_KEYS.executor)).toBe('container')
  })

  it('saves only what a change names and returns all the settings', () => {
    const { store, values } = memoryStore()
    const saved = writeRunnerConfig(
      store,
      { enabled: true, slots: 3, jobCpus: 4, jobMemoryBytes: 8 * GIB, gpu: true, storageDir: '/data/runner' },
      'linux'
    )
    expect(saved).toEqual({
      enabled: true,
      executor: 'native',
      slots: 3,
      jobCpus: 4,
      jobMemoryBytes: 8 * GIB,
      gpu: true,
      storageDir: '/data/runner',
      blobCapBytes: 50 * GIB,
    })
    expect(readRunnerConfig(store, 'linux')).toEqual(saved)
    // Nothing the change did not name was written.
    expect(values.has(RUNNER_SETTING_KEYS.executor)).toBe(false)
    expect(values.has(RUNNER_SETTING_KEYS.blobCapBytes)).toBe(false)
    expect(values.get(RUNNER_SETTING_KEYS.enabled)).toBe('1')
    expect(values.get(RUNNER_SETTING_KEYS.slots)).toBe('3')
  })

  it('clears a limit or the folder by saving null, and reads them as the default again', () => {
    const { store } = memoryStore()
    writeRunnerConfig(store, { jobCpus: 2, jobMemoryBytes: 4 * GIB, storageDir: '/data/runner' }, 'linux')
    const cleared = writeRunnerConfig(store, { jobCpus: null, jobMemoryBytes: null, storageDir: null }, 'linux')
    expect(cleared).toMatchObject({ jobCpus: null, jobMemoryBytes: null, storageDir: null })
    expect(readRunnerConfig(store, 'linux')).toMatchObject({ jobCpus: null, jobMemoryBytes: null, storageDir: null })
  })

  it('refuses a value out of range or of the wrong kind, an unknown field and a relative folder, and saves nothing', () => {
    const { store, values } = memoryStore()
    for (const bad of [
      { slots: 0 },
      { slots: 9 },
      { slots: 1.5 },
      { slots: '2' },
      { jobCpus: 0 },
      { jobCpus: -1 },
      { jobMemoryBytes: 1024 },
      { blobCapBytes: 1 },
      { enabled: 'yes' },
      { gpu: 1 },
      { executor: 'vm' },
      { storageDir: '' },
      { storageDir: 'relative/runner' },
      { surprise: true },
      // One bad field spoils the whole change.
      { enabled: true, slots: 99 },
    ])
      expect(() => writeRunnerConfig(store, bad, 'linux'), JSON.stringify(bad)).toThrow()
    expect(values.size).toBe(0)
  })

  it('reads the default for a value that no longer reads', () => {
    const { store } = memoryStore({
      [RUNNER_SETTING_KEYS.slots]: '12',
      [RUNNER_SETTING_KEYS.jobCpus]: 'many',
      [RUNNER_SETTING_KEYS.executor]: 'vm',
      [RUNNER_SETTING_KEYS.blobCapBytes]: '-5',
      [RUNNER_SETTING_KEYS.jobMemoryBytes]: '',
      [RUNNER_SETTING_KEYS.storageDir]: '',
    })
    expect(readRunnerConfig(store, 'linux')).toEqual(defaultRunnerConfig('linux'))
  })
})
