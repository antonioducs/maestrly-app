import path from 'node:path'
import type { z } from 'zod'
import {
  RUNNER_BLOB_CAP_DEFAULT_BYTES,
  type RunnerConfig,
  type RunnerConfigPatch,
  type RunnerExecutorKind,
  runnerConfigPatchSchema,
  runnerConfigSchema,
} from '../../../shared/runner'

/**
 * This computer's runner settings, kept in the app settings under `runner.*`. Reading never fails: a value that is not
 * valid is the default, so a hand-edited database cannot stop the app. Writing validates.
 */

/** The few operations on app settings these functions use; the main process passes the database's. */
export interface RunnerSettingsStore {
  getFlag(key: string, fallback: boolean): boolean
  getSetting(key: string): string | null
  setFlag(key: string, value: boolean): void
  setSetting(key: string, value: string): void
}

export const RUNNER_SETTING_KEYS = {
  enabled: 'runner.enabled',
  executor: 'runner.executor',
  slots: 'runner.slots',
  jobCpus: 'runner.jobCpus',
  jobMemoryBytes: 'runner.jobMemoryBytes',
  gpu: 'runner.gpu',
  storageDir: 'runner.storageDir',
  blobCapBytes: 'runner.blobCapBytes',
} as const satisfies Record<keyof RunnerConfig, string>

/** Native jobs run as the signed-in user with `/bin/sh`: macOS and Linux only. A Windows runner offers Container. */
export const nativeExecutorAllowed = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32'

export const defaultRunnerExecutor = (platform: NodeJS.Platform = process.platform): RunnerExecutorKind =>
  nativeExecutorAllowed(platform) ? 'native' : 'container'

export const defaultRunnerConfig = (platform: NodeJS.Platform = process.platform): RunnerConfig => ({
  enabled: false,
  executor: defaultRunnerExecutor(platform),
  slots: 1,
  jobCpus: null,
  jobMemoryBytes: null,
  gpu: false,
  storageDir: null,
  blobCapBytes: RUNNER_BLOB_CAP_DEFAULT_BYTES,
})

/** The executor this system can use, whatever was asked: Native is never allowed on Windows. */
export const effectiveRunnerExecutor = (
  executor: RunnerExecutorKind,
  platform: NodeJS.Platform = process.platform
): RunnerExecutorKind => (nativeExecutorAllowed(platform) ? executor : 'container')

// A value that is not set is stored as an empty string, since app settings have no delete.
const NONE = ''

function parse<T>(schema: z.ZodType<T>, raw: string | null, convert: (text: string) => unknown): T | undefined {
  if (raw === null || raw === NONE) return undefined
  const parsed = schema.safeParse(convert(raw))
  return parsed.success ? parsed.data : undefined
}

const field = runnerConfigSchema.shape

/** The settings now, with the default for each one that was never set or no longer reads. */
export function readRunnerConfig(
  store: RunnerSettingsStore,
  platform: NodeJS.Platform = process.platform
): RunnerConfig {
  const defaults = defaultRunnerConfig(platform)
  const text = (key: keyof RunnerConfig) => store.getSetting(RUNNER_SETTING_KEYS[key])
  const number = (raw: string) => (raw.trim() === '' ? Number.NaN : Number(raw))
  return {
    enabled: store.getFlag(RUNNER_SETTING_KEYS.enabled, defaults.enabled),
    executor: effectiveRunnerExecutor(parse(field.executor, text('executor'), String) ?? defaults.executor, platform),
    slots: parse(field.slots, text('slots'), number) ?? defaults.slots,
    jobCpus: parse(field.jobCpus, text('jobCpus'), number) ?? null,
    jobMemoryBytes: parse(field.jobMemoryBytes, text('jobMemoryBytes'), number) ?? null,
    gpu: store.getFlag(RUNNER_SETTING_KEYS.gpu, defaults.gpu),
    storageDir: parse(field.storageDir, text('storageDir'), String) ?? null,
    blobCapBytes: parse(field.blobCapBytes, text('blobCapBytes'), number) ?? defaults.blobCapBytes,
  }
}

/**
 * Saves the settings a change names and returns all of them. A change that is not valid (a number out of range, an
 * unknown field) throws and saves nothing. Asking for Native on Windows saves Container.
 */
export function writeRunnerConfig(
  store: RunnerSettingsStore,
  input: unknown,
  platform: NodeJS.Platform = process.platform
): RunnerConfig {
  const patch: RunnerConfigPatch = runnerConfigPatchSchema.parse(input)
  const current = readRunnerConfig(store, platform)
  // The whole result is checked before anything is written, so a change cannot leave half of itself behind.
  const next = runnerConfigSchema.parse({ ...current, ...patch })
  if (next.storageDir !== null && !path.isAbsolute(next.storageDir))
    throw new RangeError('The storage folder must be an absolute path.')
  const merged: RunnerConfig = { ...next, executor: effectiveRunnerExecutor(next.executor, platform) }
  for (const key of Object.keys(patch) as Array<keyof RunnerConfig>) {
    const value = merged[key]
    if (key === 'enabled' || key === 'gpu') store.setFlag(RUNNER_SETTING_KEYS[key], value as boolean)
    else store.setSetting(RUNNER_SETTING_KEYS[key], value === null ? NONE : String(value))
  }
  return merged
}
