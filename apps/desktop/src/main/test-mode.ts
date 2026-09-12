import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * AGENTS_E2E=1 enables Playwright/Electron mode, isolates all persistence in dedicated userData, and
 * skips nondeterministic local-ML startup and native quit confirmation. E2E tests exercise persistence
 * without real CLI/Git/PTY execution. Centralize this seam because userData and locks are
 * chosen before initStore.
 */
export function isE2E(): boolean {
  return process.env.AGENTS_E2E === '1'
}

/**
 * Set isolated AGENTS_USERDATA inside applyChannelIdentity before the instance lock, initStore, or any
 * userData lookup. This prevents test contamination and lock/port contention with development. Fail
 * immediately if the required directory is missing.
 */
export function applyE2EUserData(): void {
  if (!isE2E()) return
  const dir = process.env.AGENTS_USERDATA?.trim()
  if (!dir) {
    throw new Error('[test-mode] AGENTS_E2E=1 requires AGENTS_USERDATA (an isolated test directory).')
  }
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
}

/** Create an isolated subdirectory within E2E userData on demand. */
export function e2eUserDataDir(...segments: string[]): string {
  if (!isE2E()) throw new Error('[test-mode] e2eUserDataDir called outside AGENTS_E2E=1.')
  const dir = path.join(app.getPath('userData'), ...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Deterministic native-picker seam because Playwright cannot control OS dialogs. Consume one entry per
 * picker from AGENTS_E2E_PROJECT_PICKERS JSON supplied at launch.
 */
export function consumeE2EProjectPicker(): string | null | undefined {
  if (!isE2E()) return undefined
  try {
    const queue = JSON.parse(process.env.AGENTS_E2E_PROJECT_PICKERS ?? '[]') as unknown
    if (!Array.isArray(queue)) return null
    const next = queue.shift()
    process.env.AGENTS_E2E_PROJECT_PICKERS = JSON.stringify(queue)
    return typeof next === 'string' ? next : null
  } catch {
    return null
  }
}
