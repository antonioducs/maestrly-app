import type { HostApi } from '../../../preload'
import type { HostId } from '../../../shared/host-key'
import { isChatProviderConnected, type ChatConfig } from '../../../shared/chat'

export interface ModelPickerRow {
  providerId: string
  providerName: string
  modelId: string
}

export interface ModelPickerRowsUpdate {
  config: ChatConfig
  rows: ModelPickerRow[]
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
 * an account that fails shows none, as before. A newer load of the same host silences an older one.
 */
export async function loadModelPickerRows(
  api: Pick<HostApi, 'chatConfig' | 'chatModels'>,
  hostId: HostId,
  onUpdate: (update: ModelPickerRowsUpdate) => void
): Promise<void> {
  const generation = (generations.get(hostId) ?? 0) + 1
  generations.set(hostId, generation)
  const config = await api.chatConfig()
  const connected = config.providers.filter(isChatProviderConnected)
  const previous = cachedModelPickerRows(hostId) ?? []
  const fresh = new Map<string, ModelPickerRow[]>()
  const publish = () => {
    if (generations.get(hostId) !== generation) return
    const rows = connected.flatMap((provider) =>
      (fresh.get(provider.id) ?? previous.filter((row) => row.providerId === provider.id)).map((row) => ({
        ...row,
        providerName: provider.name,
      }))
    )
    cacheRows(hostId, rows)
    onUpdate({ config, rows, pending: connected.length - fresh.size })
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
}

export function resetModelPickerRowsForTests(): void {
  rowsCache.clear()
  generations.clear()
}
