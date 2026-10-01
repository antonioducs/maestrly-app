import { z } from 'zod'
import type { FleetInstallRecord } from '../../../shared/fleet-installer'
import { isSecureStorageAvailable, secureGet, secureRemove, secureSet } from '../../secure-store'
import { getAppSetting, setAppSetting } from '../../store'

/**
 * What Maestrly installed, in app settings (no secret), and its SSH key to a VPS, in the OS keyring. Without secure
 * storage the key stays in memory only, and the owner signs in again after a restart.
 */
const RECORD_KEY = 'fleet.installer'
const SSH_KEY = 'fleet.installer.sshKey'
let memoryKey: string | null = null

const port = z.number().int().min(1).max(65535)
const recordSchema = z
  .object({
    mode: z.enum(['local', 'remote']),
    version: z.string().min(1).max(128).nullable(),
    port,
    artifactsOnly: z.boolean().optional(),
    artifactsPort: port.nullable().optional(),
    remoteArtifactsPort: port.nullable().optional(),
    allowPrivateNetwork: z.boolean(),
    remote: z
      .object({
        host: z.string().min(1).max(255),
        port,
        username: z.string().min(1).max(32),
        hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{1,64}$/),
        keyTag: z.string().regex(/^maestrly-[a-z0-9]{12}$/),
      })
      .strict()
      .nullable(),
    installedAt: z.string().min(1).max(64),
  })
  .strict()
  .refine((record) => (record.mode === 'remote') === (record.remote !== null), 'A VPS install names its server')

export function readInstallRecord(): FleetInstallRecord | null {
  const raw = getAppSetting(RECORD_KEY)
  if (!raw) return null
  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeInstallRecord(record: FleetInstallRecord): void {
  setAppSetting(RECORD_KEY, JSON.stringify(recordSchema.parse(record)))
}

export function clearInstallRecord(): void {
  setAppSetting(RECORD_KEY, '')
}

export function readSshKey(): string | null {
  return memoryKey ?? secureGet(SSH_KEY)
}

export function saveSshKey(privateKey: string): 'secure' | 'memory' {
  if (secureSet(SSH_KEY, privateKey)) {
    memoryKey = null
    return 'secure'
  }
  // An older persisted key must not outlive the one that replaced it.
  secureRemove(SSH_KEY)
  memoryKey = privateKey
  return 'memory'
}

export function clearSshKey(): void {
  memoryKey = null
  secureRemove(SSH_KEY)
}

/** Where the SSH key lives; null without one. */
export function sshKeyPersistence(): 'secure' | 'memory' | null {
  if (memoryKey) return 'memory'
  return isSecureStorageAvailable() && secureGet(SSH_KEY) ? 'secure' : null
}
