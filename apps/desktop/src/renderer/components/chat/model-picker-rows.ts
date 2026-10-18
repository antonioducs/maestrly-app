import type { HostApi } from '../../../preload'
import type { HostId } from '../../../shared/host-key'
import {
  isChatProviderConnected,
  isChatProviderKeyRejected,
  isChatSubscriptionProviderKind,
  type ChatConfig,
} from '../../../shared/chat'

export interface ModelPickerRow {
  providerId: string
  providerName: string
  modelId: string
}

/** An account whose list is empty because the provider refused its API key. */
export interface ModelPickerFailure {
  providerId: string
  providerName: string
  /** HTTP status the provider answered with (401 or 403). */
  status?: number
}

export interface ModelPickerRowsUpdate {
  config: ChatConfig
  rows: ModelPickerRow[]
  /** Accounts shown as one error line instead of their models. */
  failures: ModelPickerFailure[]
  /** Accounts whose list has not arrived yet; their rows are the cached ones meanwhile. */
  pending: number
}

const STORAGE_PREFIX = 'chat.modelPicker.rows.v1:'
const rowsCache = new Map<HostId, ModelPickerRow[]>()
const generations = new Map<HostId, number>()

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

function isRow(value: unknown): value is ModelPickerRow {
  const row = value as Partial<ModelPickerRow> | null
  return typeof row?.providerId === 'string' && typeof row.providerName === 'string' && typeof row.modelId === 'string'
}

/** The host's last lists, kept across restarts so the picker opens on them while every account answers again. */
export function cachedModelPickerRows(hostId: HostId): ModelPickerRow[] | undefined {
  const cached = rowsCache.get(hostId)
  if (cached) return cached
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(STORAGE_PREFIX + hostId) ?? 'null')
    if (!Array.isArray(stored)) return undefined
    const rows = stored.filter(isRow)
    rowsCache.set(hostId, rows)
    return rows
  } catch {
    return undefined
  }
}

function cacheRows(hostId: HostId, rows: ModelPickerRow[]): void {
  rowsCache.set(hostId, rows)
  try {
    storage()?.setItem(STORAGE_PREFIX + hostId, JSON.stringify(rows))
  } catch {
    // Storage full or unavailable: the in-memory cache still serves this session.
  }
}

/**
 * Asks every connected account for its models and reports after each answer, so one slow account (a subscription
 * runtime starting up) delays only its own rows. Until an account answers, its rows from the last list stand in;
 * an account that fails shows none. An API-key account whose key the provider refused shows a failure instead of
 * vanishing: its listing is what checks the key, so the config is read again once an API-key account came back
 * empty. A newer load of the same host silences an older one.
 */
export async function loadModelPickerRows(
  api: Pick<HostApi, 'chatConfig' | 'chatModels'>,
  hostId: HostId,
  onUpdate: (update: ModelPickerRowsUpdate) => void
): Promise<void> {
  const generation = (generations.get(hostId) ?? 0) + 1
  generations.set(hostId, generation)
  let config = await api.chatConfig()
  const connected = config.providers.filter(isChatProviderConnected)
  const previous = cachedModelPickerRows(hostId) ?? []
  const fresh = new Map<string, ModelPickerRow[]>()
  const keyCheckOf = (providerId: string) => config.providers.find((candidate) => candidate.id === providerId)?.keyCheck
  const rejected = (providerId: string) =>
    isChatProviderKeyRejected({ keyCheck: keyCheckOf(providerId) }) && !fresh.get(providerId)?.length
  const publish = () => {
    if (generations.get(hostId) !== generation) return
    const rows = connected.flatMap((provider) =>
      (
        fresh.get(provider.id) ??
        (rejected(provider.id) ? [] : previous.filter((row) => row.providerId === provider.id))
      ).map((row) => ({
        ...row,
        providerName: provider.name,
      }))
    )
    const failures = connected
      .filter((provider) => rejected(provider.id))
      .map((provider) => ({
        providerId: provider.id,
        providerName: provider.name,
        ...(keyCheckOf(provider.id)?.status ? { status: keyCheckOf(provider.id)?.status } : {}),
      }))
    cacheRows(hostId, rows)
    onUpdate({ config, rows, failures, pending: connected.length - fresh.size })
  }
  publish()
  await Promise.all(
    connected.map((provider) =>
      api
        .chatModels(provider.id)
        .catch(() => [] as string[])
        .then((models) => {
          fresh.set(
            provider.id,
            models.map((modelId) => ({ providerId: provider.id, providerName: provider.name, modelId }))
          )
          publish()
        })
    )
  )
  const emptyApiKeyAccount = connected.some(
    (provider) => !isChatSubscriptionProviderKind(provider.kind) && !fresh.get(provider.id)?.length
  )
  if (!emptyApiKeyAccount || generations.get(hostId) !== generation) return
  const refreshed = await api.chatConfig().catch(() => null)
  if (!refreshed) return
  config = refreshed
  publish()
}

export function resetModelPickerRowsForTests(): void {
  rowsCache.clear()
  generations.clear()
}
