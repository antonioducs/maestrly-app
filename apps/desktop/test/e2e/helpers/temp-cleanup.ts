import { existsSync, rmSync } from 'node:fs'

const RETRYABLE_REMOVE_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function retryableRemoveError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    RETRYABLE_REMOVE_CODES.has(error.code)
  )
}

/**
 * Electron helpers can briefly recreate profile files after app.close() resolves.
 * Wait for the unique temp directory to stay absent instead of failing a completed E2E assertion.
 */
export async function removeTempDirEventually(dir: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      lastError = undefined
    } catch (error) {
      if (!retryableRemoveError(error)) throw error
      lastError = error
    }

    await delay(150)
    if (!existsSync(dir)) return
  }

  console.warn(`[e2e] Could not fully remove temporary directory ${dir}`, lastError)
}
