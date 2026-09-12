import type { Settings } from '@anthropic-ai/claude-agent-sdk'
import { getAppSetting, setAppSetting } from '../../store'
import { listCatalogProviderModelIds } from '../model-meta'

type AnthropicModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku'

const CACHE_KEY = 'chat.claude.modelCatalog'
const CACHE_TTL_MS = 15 * 60 * 1000
const MODEL_ID = /^claude-(fable|opus|sonnet|haiku)-[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_MODELS = 200

const BEHAVES_AS: Record<AnthropicModelFamily, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
}

export interface ClaudeRemoteCatalogModel {
  id: string
  family: AnthropicModelFamily
  label: string
  description: string
  behavesAs: string
  createdAt: string | null
  capabilities: string[]
}

interface PersistedClaudeCatalog {
  at: number
  fetchedAt: string | null
  source: 'models.dev' | 'bundled'
  models: ClaudeRemoteCatalogModel[]
}

let seeded = false
let cache: PersistedClaudeCatalog | null = null
let inflight: Promise<ClaudeRemoteCatalogModel[]> | null = null
const listeners = new Set<() => void>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function familyFor(id: string): AnthropicModelFamily | null {
  return (MODEL_ID.exec(id)?.[1] as AnthropicModelFamily | undefined) ?? null
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function defaultLabel(id: string): string {
  return id
    .replace(/^claude-/, '')
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function supportedModelsDevFallback(id: string): boolean {
  const match = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id)
  if (!match) return false
  const family = match[1] as AnthropicModelFamily
  const major = Number(match[2])
  const minor = Number(match[3] ?? 0)
  if (major >= 5) return true
  if (major !== 4) return false
  if (family === 'fable') return false
  if (family === 'haiku') return minor >= 5
  return minor >= 6
}

function sanitizeModel(value: unknown): ClaudeRemoteCatalogModel | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : ''
  const family = familyFor(id)
  if (!family || id.length > 128) return null
  const rawLabel =
    typeof value.label === 'string'
      ? value.label.trim()
      : typeof value.display_name === 'string'
        ? value.display_name.trim()
        : ''
  const label = rawLabel && rawLabel.length <= 160 ? rawLabel : defaultLabel(id)
  const rawDescription = typeof value.description === 'string' ? value.description.trim() : ''
  const description =
    rawDescription && rawDescription.length <= 240 ? rawDescription : `${label} · Anthropic model catalog`
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities
        .filter((entry): entry is string => typeof entry === 'string' && /^[a-z][a-z0-9_:]{0,96}$/.test(entry))
        .slice(0, 64)
    : []
  return {
    id,
    family,
    label,
    description,
    behavesAs: BEHAVES_AS[family],
    createdAt: normalizeIso(value.createdAt ?? value.created_at),
    capabilities: [...new Set(capabilities)].sort(),
  }
}

export function sanitizeClaudeRemoteCatalog(values: readonly unknown[]): ClaudeRemoteCatalogModel[] {
  const byId = new Map<string, ClaudeRemoteCatalogModel>()
  for (const value of values.slice(0, MAX_MODELS)) {
    const model = sanitizeModel(value)
    if (model && !byId.has(model.id)) byId.set(model.id, model)
  }
  return [...byId.values()].sort((a, b) => {
    const dateOrder = (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0)
    return dateOrder || a.id.localeCompare(b.id)
  })
}

function seedFromDisk(): void {
  if (seeded) return
  seeded = true
  try {
    const raw = getAppSetting(CACHE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Partial<PersistedClaudeCatalog>
    const models = sanitizeClaudeRemoteCatalog(Array.isArray(parsed.models) ? parsed.models : [])
    if (!models.length || typeof parsed.at !== 'number') return
    cache = {
      at: parsed.at,
      fetchedAt: normalizeIso(parsed.fetchedAt),
      source: parsed.source === 'bundled' ? 'bundled' : 'models.dev',
      models,
    }
  } catch {
    cache = null
  }
}

function signature(models: readonly ClaudeRemoteCatalogModel[]): string {
  return models.map((model) => `${model.id}\0${model.label}\0${model.behavesAs}`).join('\u0001')
}

function store(next: PersistedClaudeCatalog): ClaudeRemoteCatalogModel[] {
  const changed = signature(cache?.models ?? []) !== signature(next.models)
  cache = next
  try {
    setAppSetting(CACHE_KEY, JSON.stringify(next))
  } catch {
    // The in-memory cache remains authoritative for this process.
  }
  if (changed) for (const listener of listeners) listener()
  return next.models.map((model) => ({ ...model, capabilities: [...model.capabilities] }))
}

async function fromModelsDev(): Promise<ClaudeRemoteCatalogModel[]> {
  const ids = await listCatalogProviderModelIds('anthropic')
  return sanitizeClaudeRemoteCatalog(
    ids.filter(supportedModelsDevFallback).map((id) => ({ id, label: defaultLabel(id) }))
  )
}

async function refresh(): Promise<ClaudeRemoteCatalogModel[]> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const models = await fromModelsDev().catch(() => [])
      if (models.length) {
        return store({ at: Date.now(), fetchedAt: null, source: 'models.dev', models })
      }
      // Preserve previously discovered models offline. A first run still has a useful bundled picker;
      // the SDK's account-aware discovery remains authoritative when the runtime is available.
      if (cache?.models.length) {
        return cache.models.map((model) => ({ ...model, capabilities: [...model.capabilities] }))
      }
      return store({
        at: Date.now(),
        fetchedAt: null,
        source: 'bundled',
        models: sanitizeClaudeRemoteCatalog(Object.values(BEHAVES_AS).map((id) => ({ id }))),
      })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Stale-while-revalidate catalog: return cached entries immediately and refresh stale data in the background.
 * Forced refreshes and the first load await the public catalog or fallback. Never run a model turn to test access.
 */
export async function listClaudeRemoteCatalog(force = false): Promise<ClaudeRemoteCatalogModel[]> {
  seedFromDisk()
  if (!force && cache) {
    if (Date.now() - cache.at >= CACHE_TTL_MS) void refresh()
    return cache.models.map((model) => ({ ...model, capabilities: [...model.capabilities] }))
  }
  return refresh()
}

export function claudeModelPickerSnapshot(): NonNullable<Settings['modelPicker']> | null {
  seedFromDisk()
  if (!cache?.models.length) return null
  return {
    replaceBuiltInOptions: false,
    options: cache.models.map((model) => ({
      model: model.id,
      label: model.label,
      description: model.description,
      behavesAs: model.behavesAs,
    })),
  }
}

export function claudeRemoteCatalogSnapshot(): ClaudeRemoteCatalogModel[] {
  seedFromDisk()
  return (cache?.models ?? []).map((model) => ({ ...model, capabilities: [...model.capabilities] }))
}

export function onClaudeRemoteCatalogChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetClaudeRemoteCatalogForTests(): void {
  seeded = false
  cache = null
  inflight = null
  listeners.clear()
}
