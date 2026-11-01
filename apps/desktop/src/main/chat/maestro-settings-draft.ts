import { sanitizeMaestroDraftShape } from '../../shared/maestro-config-validation'
import type { MaestroSettingsDraftSession } from '../../shared/maestro-configurator'
import type { MaestroOrchestratorProfileV1 } from '../../shared/maestro'

const MAX_SESSION_BYTES = 600_000

/** Process memory on purpose: unsaved work lives as long as the app, never across restarts. */
let session: MaestroSettingsDraftSession | null = null

const clone = (value: MaestroSettingsDraftSession): MaestroSettingsDraftSession =>
  JSON.parse(JSON.stringify(value)) as MaestroSettingsDraftSession

function orchestratorFrom(value: unknown): MaestroOrchestratorProfileV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.providerId !== 'string' || typeof raw.modelId !== 'string') return null
  return {
    providerId: raw.providerId,
    modelId: raw.modelId,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : 'off',
    fastMode: raw.fastMode === true,
  }
}

export function getMaestroSettingsDraft(): MaestroSettingsDraftSession | null {
  return session ? clone(session) : null
}

export function setMaestroSettingsDraft(value: unknown): { ok: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
  const raw = value as Record<string, unknown>
  const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : ''
  const draft = sanitizeMaestroDraftShape(raw.draft)
  if (!profileId || profileId.length > 120 || !draft) return { ok: false }
  const next: MaestroSettingsDraftSession = {
    profileId,
    profileName: typeof raw.profileName === 'string' ? raw.profileName.slice(0, 80) : '',
    draft,
    orchestrator: orchestratorFrom(raw.orchestrator),
    savedHash: typeof raw.savedHash === 'string' ? raw.savedHash.slice(0, 40) : '',
  }
  if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_SESSION_BYTES) return { ok: false }
  session = next
  return { ok: true }
}

export function clearMaestroSettingsDraft(): void {
  session = null
}
