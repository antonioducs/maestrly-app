import { createHash } from 'node:crypto'
import { getAppSetting, setAppSetting, writeSettingsRevision } from '../../../store/app-settings'
import { InstanceHttpError } from '../server'

// Canonical resource keys are documented at the central app_settings write observer.
const queues = new Map<string, Promise<void>>()
export function settingsRevision(resource: string): string {
  const key = 'fleet.settings.revision.' + resource
  let value = getAppSetting(key)
  if (!value) {
    writeSettingsRevision(resource)
    value = getAppSetting(key)
  }
  if (!value) throw new Error('Could not persist settings revision')
  return value
}
export function touchSettingsRevision(resource: string): void {
  writeSettingsRevision(resource)
}

/** Serializes compare-and-mutate for each resource, including asynchronous filesystem operations. */
export async function withSettingsRevision<T>(
  resource: string,
  expectedRevision: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const previous = queues.get(resource) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => pending)
  queues.set(resource, tail)
  await previous
  try {
    if (settingsRevision(resource) !== expectedRevision)
      throw new InstanceHttpError(409, 'CONFLICT', 'Settings changed. Reload before saving.')
    const result = await operation()
    touchSettingsRevision(resource)
    return result
  } finally {
    release()
    if (queues.get(resource) === tail) queues.delete(resource)
  }
}

/** Detect external filesystem changes without exposing content-derived values as public revisions. */
export function observeSettingsRevision(resource: string, snapshot: unknown): string {
  const key = 'fleet.settings.snapshot.' + resource
  const digest = createHash('sha256')
    .update(JSON.stringify(snapshot) ?? 'undefined')
    .digest('hex')
  const before = getAppSetting(key)
  if (before !== digest) {
    if (before !== null) touchSettingsRevision(resource)
    setAppSetting(key, digest)
  }
  return settingsRevision(resource)
}
