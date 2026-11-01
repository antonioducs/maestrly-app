import {
  MAESTRO_CONFIGURATOR_MAX_IMAGES,
  MAESTRO_CONFIGURATOR_THREAD_VERSION,
  type MaestroConfiguratorImageRef,
  type MaestroConfiguratorMessage,
  type MaestroConfiguratorProfile,
  type MaestroConfiguratorThread,
  type MaestroConfiguratorThreadEvent,
} from '../../shared/maestro-configurator'
import { getAppSetting, setAppSetting } from '../store'

const THREAD_KEY = 'chat.maestro.configurator.thread.v1'
const PROFILE_KEY = 'chat.maestro.configurator.profile.v1'
const MAX_MESSAGES = 40
const MAX_TEXT_CHARS = 40_000
const MAX_THREAD_BYTES = 600_000
const MAX_PROPOSAL_BYTES = 350_000

const emptyThread = (): MaestroConfiguratorThread => ({
  version: MAESTRO_CONFIGURATOR_THREAD_VERSION,
  messages: [],
})

const MAX_IMAGE_DESCRIPTION_CHARS = 12_000

function sanitizeImages(value: unknown): MaestroConfiguratorImageRef[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAESTRO_CONFIGURATOR_MAX_IMAGES).flatMap((item): MaestroConfiguratorImageRef[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const raw = item as Record<string, unknown>
    if (typeof raw.name !== 'string' || typeof raw.mediaType !== 'string') return []
    return [
      {
        name: raw.name.slice(0, 200),
        mediaType: raw.mediaType.slice(0, 40),
        byteSize: typeof raw.byteSize === 'number' && raw.byteSize >= 0 ? raw.byteSize : 0,
        ...(typeof raw.description === 'string' && raw.description
          ? { description: raw.description.slice(0, MAX_IMAGE_DESCRIPTION_CHARS) }
          : {}),
        ...(typeof raw.descriptionModel === 'string' && raw.descriptionModel
          ? { descriptionModel: raw.descriptionModel.slice(0, 200) }
          : {}),
      },
    ]
  })
}

const PROFILE_SOURCES = ['global', 'builtin', 'custom'] as const
const SAVE_TARGETS = ['global', 'custom', 'new-custom'] as const
const name = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 120) : '')

export function sanitizeMaestroConfiguratorEvent(value: unknown): MaestroConfiguratorThreadEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  switch (raw.kind) {
    case 'proposal-applied': {
      if (typeof raw.proposalId !== 'string' || !raw.proposalId) return null
      const skipped = Array.isArray(raw.skipped)
        ? [
            ...new Set(
              raw.skipped.filter(
                (key): key is string =>
                  typeof key === 'string' && (key === 'strategy' || /^resource:.{1,120}$/.test(key))
              )
            ),
          ].slice(0, 100)
        : []
      return {
        kind: 'proposal-applied',
        proposalId: raw.proposalId.slice(0, 120),
        ...(skipped.length ? { skipped } : {}),
      }
    }
    case 'proposal-dismissed':
      return typeof raw.proposalId === 'string' && raw.proposalId
        ? { kind: 'proposal-dismissed', proposalId: raw.proposalId.slice(0, 120) }
        : null
    case 'draft-discarded':
      return { kind: 'draft-discarded', profileName: name(raw.profileName) }
    case 'saved':
      return SAVE_TARGETS.includes(raw.target as (typeof SAVE_TARGETS)[number])
        ? {
            kind: 'saved',
            target: raw.target as (typeof SAVE_TARGETS)[number],
            profileName: name(raw.profileName),
          }
        : null
    case 'profile-selected':
      return typeof raw.profileId === 'string' &&
        raw.profileId &&
        PROFILE_SOURCES.includes(raw.source as (typeof PROFILE_SOURCES)[number])
        ? {
            kind: 'profile-selected',
            profileId: raw.profileId.slice(0, 120),
            profileName: name(raw.profileName),
            source: raw.source as (typeof PROFILE_SOURCES)[number],
          }
        : null
    default:
      return null
  }
}

function sanitizeMessage(value: unknown): MaestroConfiguratorMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || (raw.role !== 'user' && raw.role !== 'assistant' && raw.role !== 'event')) {
    return null
  }
  if (typeof raw.text !== 'string' || typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null
  const message: MaestroConfiguratorMessage = {
    id: raw.id,
    role: raw.role,
    text: raw.text.slice(0, MAX_TEXT_CHARS),
    createdAt: raw.createdAt,
  }
  if (raw.role === 'event') {
    const event = sanitizeMaestroConfiguratorEvent(raw.event)
    return event ? { ...message, event } : null
  }
  const images = sanitizeImages(raw.images)
  if (raw.role === 'user' && images.length) message.images = images
  if (
    raw.model &&
    typeof raw.model === 'object' &&
    !Array.isArray(raw.model) &&
    typeof (raw.model as Record<string, unknown>).providerId === 'string' &&
    typeof (raw.model as Record<string, unknown>).modelId === 'string'
  ) {
    message.model = {
      providerId: (raw.model as { providerId: string }).providerId,
      modelId: (raw.model as { modelId: string }).modelId,
    }
  }
  if (raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) {
    const usage = raw.usage as Record<string, unknown>
    if (typeof usage.input === 'number' && typeof usage.output === 'number') {
      message.usage = {
        input: Math.max(0, usage.input),
        output: Math.max(0, usage.output),
        cacheRead: typeof usage.cacheRead === 'number' ? Math.max(0, usage.cacheRead) : 0,
        cacheCreate: typeof usage.cacheCreate === 'number' ? Math.max(0, usage.cacheCreate) : 0,
        ...(typeof usage.runtimeEstimatedCostUsd === 'number' && usage.runtimeEstimatedCostUsd >= 0
          ? { runtimeEstimatedCostUsd: usage.runtimeEstimatedCostUsd }
          : {}),
      }
    }
  }
  // Proposal was produced and validated by the main process. Preserve it as an opaque public contract here;
  // the service revalidates before emitting state and the renderer rechecks the base hash before applying.
  if (raw.proposal && typeof raw.proposal === 'object' && !Array.isArray(raw.proposal)) {
    const serialized = JSON.stringify(raw.proposal)
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_PROPOSAL_BYTES) {
      message.proposal = raw.proposal as MaestroConfiguratorMessage['proposal']
    }
  }
  return message
}

export function getMaestroConfiguratorThread(): MaestroConfiguratorThread {
  const stored = getAppSetting(THREAD_KEY)
  if (!stored) return emptyThread()
  try {
    const raw = JSON.parse(stored) as { version?: unknown; messages?: unknown }
    if (raw.version !== MAESTRO_CONFIGURATOR_THREAD_VERSION || !Array.isArray(raw.messages)) return emptyThread()
    return {
      version: MAESTRO_CONFIGURATOR_THREAD_VERSION,
      messages: raw.messages
        .map(sanitizeMessage)
        .filter((message): message is MaestroConfiguratorMessage => !!message)
        .slice(-MAX_MESSAGES),
    }
  } catch {
    return emptyThread()
  }
}

export function setMaestroConfiguratorThread(thread: MaestroConfiguratorThread): MaestroConfiguratorThread {
  const messages = thread.messages
    .slice(-MAX_MESSAGES)
    .map(sanitizeMessage)
    .filter((message): message is MaestroConfiguratorMessage => !!message)
  while (messages.length > 1) {
    const candidate = { version: MAESTRO_CONFIGURATOR_THREAD_VERSION, messages }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MAX_THREAD_BYTES) break
    messages.shift()
  }
  const value: MaestroConfiguratorThread = { version: MAESTRO_CONFIGURATOR_THREAD_VERSION, messages }
  setAppSetting(THREAD_KEY, JSON.stringify(value))
  return value
}

export function appendMaestroConfiguratorMessage(message: MaestroConfiguratorMessage): MaestroConfiguratorThread {
  const thread = getMaestroConfiguratorThread()
  return setMaestroConfiguratorThread({ ...thread, messages: [...thread.messages, message] })
}

/** Replaces a message in place (by id); a message no longer in the thread stays gone. */
export function updateMaestroConfiguratorMessage(message: MaestroConfiguratorMessage): MaestroConfiguratorThread {
  const thread = getMaestroConfiguratorThread()
  return setMaestroConfiguratorThread({
    ...thread,
    messages: thread.messages.map((current) => (current.id === message.id ? message : current)),
  })
}

export function resetMaestroConfiguratorThread(): MaestroConfiguratorThread {
  return setMaestroConfiguratorThread(emptyThread())
}

export function getStoredMaestroConfiguratorProfile(): MaestroConfiguratorProfile | null {
  const stored = getAppSetting(PROFILE_KEY)
  if (!stored) return null
  try {
    const raw = JSON.parse(stored) as Record<string, unknown>
    if (
      typeof raw.providerId !== 'string' ||
      !raw.providerId ||
      typeof raw.modelId !== 'string' ||
      !raw.modelId ||
      typeof raw.effort !== 'string' ||
      !raw.effort
    ) {
      return null
    }
    return {
      providerId: raw.providerId,
      modelId: raw.modelId,
      effort: raw.effort,
      ...(raw.fastMode === true ? { fastMode: true } : {}),
    }
  } catch {
    return null
  }
}

export function setStoredMaestroConfiguratorProfile(profile: MaestroConfiguratorProfile): MaestroConfiguratorProfile {
  const value: MaestroConfiguratorProfile = {
    providerId: profile.providerId.trim(),
    modelId: profile.modelId.trim(),
    effort: profile.effort.trim().toLowerCase(),
    ...(profile.fastMode === true ? { fastMode: true } : {}),
  }
  setAppSetting(PROFILE_KEY, JSON.stringify(value))
  return value
}
