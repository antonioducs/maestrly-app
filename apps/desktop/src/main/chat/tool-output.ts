import { createHash, randomUUID } from 'node:crypto'
import type { JSONValue } from '@ai-sdk/provider'
import type { ToolResultOutput } from '@ai-sdk/provider-utils'
import type { ChatToolImage, ChatToolOutput, ToolOutput } from '../../shared/chat'
import { toolOutputImages, toolOutputText } from '../../shared/chat'
import { registerReclaimable, unregisterReclaimable } from '../performance/memory-reclaimer'
import {
  TOOL_IMAGE_CACHE_BUDGET_BYTES,
  TOOL_IMAGE_CACHE_HARD_TRIM_BYTES,
  TOOL_IMAGE_CACHE_TTL_MS,
} from '../../shared/memory-policy'

/**
 * Tool results cross several runtimes with incompatible content contracts. This module is the host-owned
 * boundary: raw image data is accepted only in memory, converted to opaque references for chat state, and
 * projected back into the native provider shape immediately before a model request.
 */

export const MAESTRLY_TOOL_OUTPUT_METADATA = '__maestrlyToolOutput'
/** Maximum decoded size accepted for one ephemeral tool image. */
export const MAX_EPHEMERAL_IMAGE_BYTES = 16 * 1024 * 1024
/** Aggregate decoded-byte budget for the process-local tool-image cache. */
export const MAX_EPHEMERAL_IMAGE_CACHE_BYTES = TOOL_IMAGE_CACHE_BUDGET_BYTES
/** Maximum image blocks/calls retained or interpreted for one tool result. */
export const MAX_TOOL_IMAGES_PER_RESULT = 8
/** Entry and TTL bounds shared by process-local caches attached to tool-image handles. */
export const MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES = 512
export const EPHEMERAL_IMAGE_CACHE_TTL_MS = TOOL_IMAGE_CACHE_TTL_MS
const MAX_STRUCTURED_CONTENT_CHARS = 32_000
const DATA_URL_BINARY_RE = /data:[^;,\s]+;base64,[A-Za-z0-9+/=\s]+/gi
const LONG_BASE64_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{256,}={0,2}(?![A-Za-z0-9+/=])/g
const OPAQUE_TOOL_IMAGE_ID_RE = /^tool-image:[A-Za-z0-9_-]{1,128}$/

interface CachedToolImage {
  bytes: Uint8Array
  mediaType: string
  byteSize: number
  cacheKey: string
  lastAccessAt: number
  accessOrder: number
}

const ephemeralImages = new Map<string, CachedToolImage>()
const ephemeralImageIdsByCacheKey = new Map<string, string>()
const ephemeralImageCacheEvictionListeners = new Set<(imageId: string | null) => void>()
const ephemeralImageConversationCleanupListeners = new Set<(cleanup: EphemeralImageConversationCleanup) => void>()
let ephemeralImageBytes = 0
let ephemeralImageAccessOrder = 0

/**
 * Tool-image cache is a ReclaimableResource in the shared reclaimer: normal TTL becomes a scheduled
 * deadline (prune without another cache access), while hard/manual reclaim trims to the hard target.
 * Register only while entries exist — an empty cache must not keep the schedule timer alive.
 */
const TOOL_IMAGE_CACHE_RECLAIM_KEY = 'tool-image-cache'
let toolImageCacheReclaimableRegistered = false

function toolImageCacheLastAccessAt(): number {
  let earliest = 0
  for (const entry of ephemeralImages.values()) {
    if (earliest === 0 || entry.lastAccessAt < earliest) earliest = entry.lastAccessAt
  }
  return earliest || Date.now()
}

function syncToolImageCacheReclaimable(): void {
  const shouldRegister = ephemeralImages.size > 0
  if (shouldRegister === toolImageCacheReclaimableRegistered) return
  toolImageCacheReclaimableRegistered = shouldRegister
  if (shouldRegister) {
    registerReclaimable({
      key: TOOL_IMAGE_CACHE_RECLAIM_KEY,
      kind: 'cache',
      lastActiveAt: toolImageCacheLastAccessAt,
      coldTtlMs: EPHEMERAL_IMAGE_CACHE_TTL_MS,
      priority: 10,
      estimatedBytes: () => ephemeralImageBytes,
      protection: () => ({ protected: false, reasons: [] }),
      prepare: async () => ({ ok: true }),
      evict: (mode) => {
        // Normal/soft = TTL (expired entries + budget); hard (hard pressure OR manual) = hard target.
        if (mode === 'hard') trimEphemeralToolImageCache(true)
        else pruneEphemeralImages()
      },
    })
  } else {
    unregisterReclaimable(TOOL_IMAGE_CACHE_RECLAIM_KEY)
  }
}

/**
 * Lets process-local metadata caches follow the lifecycle of the host-owned image bytes.
 * `null` means that the entire byte cache was cleared.
 */
export function onEphemeralToolImageCacheEviction(listener: (imageId: string | null) => void): () => void {
  ephemeralImageCacheEvictionListeners.add(listener)
  return () => ephemeralImageCacheEvictionListeners.delete(listener)
}

function notifyEphemeralImageCacheEviction(imageId: string | null): void {
  for (const listener of ephemeralImageCacheEvictionListeners) {
    try {
      listener(imageId)
    } catch {
      // Auxiliary cache cleanup must never change the tool-output boundary's behavior.
    }
  }
}

/**
 * Durable rows owned by one conversation are being removed. `refs` scopes the cleanup to the removed
 * image handles/file parts; `conversation` means every row of a still-usable conversation is gone
 * (clear/truncate); `deleted` means the conversation itself was deleted and its id will never be reused.
 */
export type EphemeralImageConversationCleanup =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'deleted'; conversationId: string }
  | { kind: 'refs'; conversationId: string; removedIds: ReadonlySet<string> }

/**
 * Lets conversation-scoped tool-image metadata (e.g. interpreter descriptions) follow the deletion of
 * their durable chat rows, even when the shared content-addressed byte handle survives for another owner.
 */
export function onEphemeralImageConversationCleanup(
  listener: (cleanup: EphemeralImageConversationCleanup) => void
): () => void {
  ephemeralImageConversationCleanupListeners.add(listener)
  return () => ephemeralImageConversationCleanupListeners.delete(listener)
}

function notifyEphemeralImageConversationCleanup(cleanup: EphemeralImageConversationCleanup): void {
  for (const listener of ephemeralImageConversationCleanupListeners) {
    try {
      listener(cleanup)
    } catch {
      // Auxiliary metadata cleanup must never change the deletion path's behavior.
    }
  }
}

/** Removes conversation-scoped tool-image metadata for the specific ids whose chat rows were deleted. */
export function releaseConversationToolImageMetadata(
  conversationId: string,
  removedIds: ReadonlySet<string>
): void {
  notifyEphemeralImageConversationCleanup({ kind: 'refs', conversationId, removedIds })
}

/** Removes ALL conversation-scoped tool-image metadata for a conversation whose rows were all removed. */
export function clearConversationToolImageMetadata(conversationId: string): void {
  notifyEphemeralImageConversationCleanup({ kind: 'conversation', conversationId })
}

/** Same as `clearConversationToolImageMetadata`, and the conversation id is gone for good (cascade delete). */
export function deleteConversationToolImageMetadata(conversationId: string): void {
  notifyEphemeralImageConversationCleanup({ kind: 'deleted', conversationId })
}

function deleteEphemeralImage(id: string): void {
  const entry = ephemeralImages.get(id)
  if (!entry) return
  ephemeralImages.delete(id)
  if (ephemeralImageIdsByCacheKey.get(entry.cacheKey) === id) ephemeralImageIdsByCacheKey.delete(entry.cacheKey)
  ephemeralImageBytes -= entry.byteSize
  notifyEphemeralImageCacheEviction(id)
  if (ephemeralImages.size === 0) syncToolImageCacheReclaimable()
}

function pruneEphemeralImages(now = Date.now()): void {
  for (const [id, entry] of ephemeralImages) {
    if (now - entry.lastAccessAt > EPHEMERAL_IMAGE_CACHE_TTL_MS) deleteEphemeralImage(id)
  }
  while (
    ephemeralImages.size > MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES ||
    ephemeralImageBytes > MAX_EPHEMERAL_IMAGE_CACHE_BYTES
  ) {
    const oldest = [...ephemeralImages.entries()].sort((a, b) => a[1].accessOrder - b[1].accessOrder)[0]
    if (!oldest) break
    deleteEphemeralImage(oldest[0])
  }
}

export function getEphemeralToolImageCacheSnapshot(): { entries: number; bytes: number } {
  pruneEphemeralImages()
  return { entries: ephemeralImages.size, bytes: ephemeralImageBytes }
}

export function trimEphemeralToolImageCache(hard = false): void {
  const target = hard ? TOOL_IMAGE_CACHE_HARD_TRIM_BYTES : TOOL_IMAGE_CACHE_BUDGET_BYTES
  while (ephemeralImageBytes > target && ephemeralImages.size > 0) {
    const oldest = [...ephemeralImages.entries()].sort((a, b) => a[1].accessOrder - b[1].accessOrder)[0]
    if (!oldest) break
    deleteEphemeralImage(oldest[0])
  }
}

/** Exact decoded byte size of a base64 payload (null when not valid base64). Shared by the host boundary
 *  and by producers that must pre-bound their output (e.g. browser screenshots) to the same cap. */
export function decodedBase64ByteSize(data: string): number | null {
  const compact = data.replace(/\s/g, '')
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function base64FromData(
  value: unknown,
  mediaType?: string
): { bytes: Uint8Array; mediaType: string; byteSize: number } | null {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_EPHEMERAL_IMAGE_BYTES) return null
    return {
      bytes: Uint8Array.from(value),
      mediaType: mediaType || 'application/octet-stream',
      byteSize: value.byteLength,
    }
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_EPHEMERAL_IMAGE_BYTES) return null
    return {
      bytes: new Uint8Array(value.slice(0)),
      mediaType: mediaType || 'application/octet-stream',
      byteSize: value.byteLength,
    }
  }
  if (typeof value !== 'string') return null
  const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(value)
  const rawData = dataUrl ? dataUrl[2] : value.trim()
  const normalized = rawData.replace(/\s/g, '')
  const byteSize = decodedBase64ByteSize(normalized)
  if (byteSize === null || byteSize > MAX_EPHEMERAL_IMAGE_BYTES) return null
  return {
    bytes: Uint8Array.from(Buffer.from(normalized, 'base64')),
    mediaType: dataUrl ? dataUrl[1] : mediaType || 'application/octet-stream',
    byteSize,
  }
}

function cacheKeyForImage(decoded: { bytes: Uint8Array; mediaType: string; byteSize: number }): string {
  const digest = createHash('sha256').update(decoded.bytes).digest('hex')
  return `${decoded.mediaType}\0${decoded.byteSize}\0${digest}`
}

function toolImageReference(
  id: string,
  image: Pick<CachedToolImage, 'mediaType' | 'byteSize'>,
  metadata: Pick<ChatToolImage, 'name' | 'description' | 'descriptionModel'>
): ChatToolImage {
  return {
    id,
    mediaType: image.mediaType,
    byteSize: image.byteSize,
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.descriptionModel ? { descriptionModel: metadata.descriptionModel } : {}),
  }
}

function cacheImage(
  value: unknown,
  mediaType: string | undefined,
  metadata: Pick<ChatToolImage, 'name' | 'description' | 'descriptionModel'> = {}
): ChatToolImage | null {
  const decoded = base64FromData(value, mediaType)
  if (!decoded) return null
  pruneEphemeralImages()
  const cacheKey = cacheKeyForImage(decoded)
  const existingId = ephemeralImageIdsByCacheKey.get(cacheKey)
  if (existingId) {
    const existing = ephemeralImages.get(existingId)
    if (existing) {
      existing.lastAccessAt = Date.now()
      existing.accessOrder = ++ephemeralImageAccessOrder
      return toolImageReference(existingId, existing, metadata)
    }
    ephemeralImageIdsByCacheKey.delete(cacheKey)
  }
  while (
    ephemeralImages.size >= MAX_EPHEMERAL_IMAGE_CACHE_ENTRIES ||
    (ephemeralImages.size > 0 && ephemeralImageBytes + decoded.byteSize > MAX_EPHEMERAL_IMAGE_CACHE_BYTES)
  ) {
    const oldest = [...ephemeralImages.entries()].sort((a, b) => a[1].accessOrder - b[1].accessOrder)[0]
    if (!oldest) break
    deleteEphemeralImage(oldest[0])
  }
  const id = `tool-image:${randomUUID()}`
  const now = Date.now()
  ephemeralImages.set(id, {
    ...decoded,
    cacheKey,
    lastAccessAt: now,
    accessOrder: ++ephemeralImageAccessOrder,
  })
  ephemeralImageIdsByCacheKey.set(cacheKey, id)
  ephemeralImageBytes += decoded.byteSize
  syncToolImageCacheReclaimable()
  return toolImageReference(id, decoded, metadata)
}

/**
 * Raw lookup (existence + bytes) WITHOUT base64 projection: availability checks and byte consumers
 * (image IPC, ledger, description cache) must not allocate a string ~33% larger than binary.
 */
export function getEphemeralToolImage(
  image: Pick<ChatToolImage, 'id'>
): { bytes: Uint8Array; mediaType: string; byteSize: number } | null {
  pruneEphemeralImages()
  const entry = ephemeralImages.get(image.id)
  if (!entry) return null
  entry.lastAccessAt = Date.now()
  entry.accessOrder = ++ephemeralImageAccessOrder
  return { bytes: entry.bytes, mediaType: entry.mediaType, byteSize: entry.byteSize }
}

/** Existence check without reading bytes (also refreshes entry recency). */
export function hasEphemeralToolImage(image: Pick<ChatToolImage, 'id'>): boolean {
  return getEphemeralToolImage(image) !== null
}

/**
 * Base64 projection ONLY at the provider boundary (adapters sending images to models).
 * All non-provider lookups (IPC, ledger, cache validation) must use `getEphemeralToolImage`.
 */
export function resolveEphemeralToolImage(
  image: Pick<ChatToolImage, 'id'>
): { bytes: Uint8Array; data: string; mediaType: string; byteSize: number } | null {
  const resolved = getEphemeralToolImage(image)
  if (!resolved) return null
  return { ...resolved, data: Buffer.from(resolved.bytes).toString('base64') }
}

/**
 * Releases handles whose durable owners were removed. Ownership is intentionally supplied by the persistence
 * layer: provider bridge conversions may touch the same bytes repeatedly without creating another persisted owner.
 */
export function releaseUnreferencedEphemeralToolImages(
  removedIds: Iterable<string>,
  persistedIds: ReadonlySet<string>
): void {
  for (const id of new Set(removedIds)) {
    if (!persistedIds.has(id)) deleteEphemeralImage(id)
  }
}

/** Test/support hook; it only clears process memory and never touches persisted chat data. */
export function clearEphemeralToolImages(): void {
  ephemeralImages.clear()
  ephemeralImageIdsByCacheKey.clear()
  ephemeralImageBytes = 0
  ephemeralImageAccessOrder = 0
  notifyEphemeralImageCacheEviction(null)
  syncToolImageCacheReclaimable()
}

function jsonValue(value: unknown, depth = 0, key = ''): JSONValue | undefined {
  if (depth > 6) return '[structured content depth omitted]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '[binary content omitted]'
  if (typeof value === 'string') {
    if (/(base64|blob|binary|bytes|image[_-]?data|raw[_-]?data)/i.test(key)) {
      return '[binary content omitted]'
    }
    const sanitized = safePersistedText(value)
    return sanitized.length > MAX_STRUCTURED_CONTENT_CHARS
      ? `${sanitized.slice(0, MAX_STRUCTURED_CONTENT_CHARS)}…`
      : sanitized
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 256)
      .map((entry) => jsonValue(entry, depth + 1, key))
      .filter((entry) => entry !== undefined) as JSONValue
  }
  if (typeof value === 'object') {
    const out: Record<string, JSONValue> = {}
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>).slice(0, 256)) {
      const safe = jsonValue(entry, depth + 1, entryKey)
      if (safe !== undefined) out[entryKey] = safe
    }
    return out
  }
  return undefined
}

function safeStructuredContent(value: unknown): JSONValue | undefined {
  const safe = jsonValue(value)
  if (safe === undefined) return undefined
  try {
    const encoded = JSON.stringify(safe)
    if (encoded.length <= MAX_STRUCTURED_CONTENT_CHARS) return safe
    return encoded.slice(0, MAX_STRUCTURED_CONTENT_CHARS) + '…'
  } catch {
    return undefined
  }
}

function safePersistedText(value: string): string {
  return value
    .replace(DATA_URL_BINARY_RE, '[binary content omitted]')
    .replace(LONG_BASE64_RE, '[binary content omitted]')
}

function safePersistedImageId(id: string): string {
  // Image ids are host-owned handles, not provider references. Refuse arbitrary ids at the durable boundary so
  // an untyped adapter cannot smuggle a data URL/base64 payload into parts_json under the `id` field.
  return OPAQUE_TOOL_IMAGE_ID_RE.test(id) ? id : 'tool-image:unavailable'
}

/** Persistence-safe text projection shared by provider ledgers. */
export function sanitizeToolTextForPersistence(value: string): string {
  return safePersistedText(value)
}

/** Persistence-safe JSON projection shared by provider ledgers. */
export function sanitizeStructuredContentForPersistence(value: unknown): JSONValue | undefined {
  return safeStructuredContent(value)
}

/** Final persistence projection: refs/metadata only, with binary-looking text removed as a defence in depth. */
export function sanitizeToolOutputForPersistence(output: ToolOutput): ToolOutput {
  if (typeof output === 'string') return safePersistedText(output)
  const structuredContent = safeStructuredContent(output.structuredContent)
  return {
    text: safePersistedText(output.text),
    ...(Array.isArray(output.images)
      ? {
          images: output.images.map((image) => ({
            id: safePersistedImageId(image.id),
            mediaType: image.mediaType,
            ...(image.name ? { name: safePersistedText(image.name) } : {}),
            ...(typeof image.byteSize === 'number' ? { byteSize: image.byteSize } : {}),
            ...(image.description ? { description: safePersistedText(image.description) } : {}),
            ...(image.descriptionModel ? { descriptionModel: safePersistedText(image.descriptionModel) } : {}),
          })),
        }
      : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(output.isError ? { isError: true } : {}),
  }
}

/**
 * Converts a model-facing result into the representation safe for a durable execution checkpoint.
 * Images become opaque ChatToolImage references; ordinary scalar results retain their original shape.
 */
export function toolOutputForPersistence(output: unknown): unknown {
  const normalized = modelOutputToChatToolOutput(output)
  if (typeof normalized !== 'object' || normalized === null) {
    if (typeof output === 'string') return safePersistedText(output)
    if (output == null || typeof output === 'boolean' || typeof output === 'number') return output
    return safeStructuredContent(output) ?? null
  }

  const candidate = output && typeof output === 'object' ? (output as Record<string, unknown>) : undefined
  const modelShaped =
    candidate != null &&
    (candidate.type === 'content' ||
      candidate.type === 'json' ||
      candidate.type === 'error-json' ||
      candidate.type === 'error-text' ||
      Array.isArray(candidate.images) ||
      candidate.structuredContent !== undefined ||
      candidate.isError === true ||
      candidate[MAESTRLY_TOOL_OUTPUT_METADATA] !== undefined)
  if (
    toolOutputImages(normalized).length > 0 ||
    normalized.structuredContent !== undefined ||
    normalized.isError ||
    modelShaped
  ) {
    return sanitizeToolOutputForPersistence(normalized)
  }
  return safeStructuredContent(output) ?? null
}

function stringifyStructured(value: JSONValue | undefined): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function recordText(entry: Record<string, unknown>): string {
  if (entry.type === 'text' && typeof entry.text === 'string') return entry.text
  if (entry.type === 'resource_link') {
    const uri = typeof entry.uri === 'string' ? entry.uri : ''
    const description = typeof entry.description === 'string' ? entry.description : ''
    return [description, uri].filter(Boolean).join('\n')
  }
  if (entry.type === 'audio') return '[audio content returned by tool]'
  if (entry.type === 'resource') {
    const resource = entry.resource
    if (resource && typeof resource === 'object') {
      const raw = resource as Record<string, unknown>
      if (typeof raw.text === 'string') return raw.text
      if (typeof raw.uri === 'string') return `[resource: ${raw.uri}]`
    }
    return '[binary resource returned by tool]'
  }
  return ''
}

export interface McpToolResultLike {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

export interface ChatToolOutputResult {
  chatOutput: ChatToolOutput
  modelOutput: ToolResultOutput
}

/** Optional interpreter metadata: return null for best-effort failures; thrown errors, including aborts, propagate. */
export type DescribeToolImage = (image: ChatToolImage) => Promise<{ text: string; model?: string } | null>

/** Adds best-effort interpreter metadata without changing the host-owned image references. */
export async function describeToolOutputImages(
  output: ToolOutput,
  describeImage?: DescribeToolImage
): Promise<ToolOutput> {
  if (typeof output === 'string' || !describeImage || toolOutputImages(output).length === 0) return output

  let changed = false
  const images = [...toolOutputImages(output)]
  // Keep one tool result from opening a burst of interpreter calls. The interpreter itself owns the
  // cross-result single-flight, so this serializes unique images here without coupling this boundary to a
  // provider-specific limiter.
  for (const [index, image] of images.entries()) {
    if (index >= MAX_TOOL_IMAGES_PER_RESULT || image.description?.trim()) continue
    const described = await describeImage(image)
    if (!described?.text?.trim()) continue
    changed = true
    images[index] = {
      ...image,
      description: described.text.trim(),
      ...(described.model?.trim() ? { descriptionModel: described.model.trim() } : {}),
    }
  }
  return changed ? { ...output, images } : output
}

/**
 * Do both outputs reference exactly the SAME images (content-addressed IDs stable within the process)?
 * Post-turn enrichment ownership guard: apply descriptions only while durable state
 * still references the described images — rewritten/new output (edit, truncate,
 * reexecution) → false; discard patch instead of reverting newer state.
 */
export function toolOutputsReferenceSameImages(a: unknown, b: unknown): boolean {
  const imagesA = toolOutputImages(a as ToolOutput)
  const imagesB = toolOutputImages(b as ToolOutput)
  if (imagesA.length !== imagesB.length) return false
  if (imagesA.length === 0) return true
  const idsB = new Set(imagesB.map((image) => image.id))
  return imagesA.every((image) => idsB.has(image.id))
}

/**
 * MONOTONIC image-description merge into the authoritative CURRENT output.
 *
 * Post-turn enrichment describes images from a SNAPSHOT; when it finishes, durable output
 * may have advanced (running→completed, new text/structuredContent/isError, changed image order/metadata)
 * while retaining the SAME handles (content-addressed IDs stable within the process).
 * Replacing output with the enriched snapshot would revert those fields. Copy ONLY
 * `description`/`descriptionModel` from enriched images matched by ID into current images
 * still lacking descriptions; preserve everything else — text, structuredContent, isError, current
 * image order/metadata. No change → return `current` (same reference, nothing to write).
 */
export function mergeToolOutputImageDescriptions(
  current: ToolOutput | undefined,
  enriched: ToolOutput | undefined
): ToolOutput | undefined {
  if (typeof current === 'string' || current === undefined) return current
  if (typeof enriched === 'string' || enriched === undefined) return current
  const currentImages = toolOutputImages(current)
  const enrichedImages = toolOutputImages(enriched)
  if (currentImages.length === 0 || enrichedImages.length === 0) return current
  const enrichedById = new Map<string, ChatToolImage>()
  for (const image of enrichedImages) enrichedById.set(image.id, image)
  let changed = false
  const images = currentImages.map((image) => {
    // Current output is authoritative: never replace an existing newer-cycle description with snapshot data.
    if (image.description?.trim()) return image
    const described = enrichedById.get(image.id)
    if (!described?.description?.trim()) return image
    changed = true
    return {
      ...image,
      description: described.description,
      ...(described.descriptionModel?.trim() ? { descriptionModel: described.descriptionModel } : {}),
    }
  })
  return changed ? { ...current, images } : current
}

/** Text used when an image reference crosses a model boundary that cannot accept image content. */
export function toolImageTextForModel(image: ChatToolImage): string {
  const name = image.name ? ` "${image.name}"` : ''
  const description = image.description?.trim()
  if (!description) return `[image${name} omitted: the selected model does not accept images]`
  const by = image.descriptionModel?.trim() ? ` by ${image.descriptionModel.trim()}` : ''
  return `[image${name} — the selected model cannot see images, so here is a description${by}]\n${description}`
}

function imageFromMcpEntry(entry: Record<string, unknown>): ChatToolImage | null {
  if (entry.type === 'image') {
    // MCP uses {data,mimeType}; Anthropic's MCP bridge may surface the same block as
    // {source:{type:'base64',data,media_type}} in the user/tool-result stream.
    const source =
      entry.source && typeof entry.source === 'object' ? (entry.source as Record<string, unknown>) : undefined
    const data = entry.data ?? source?.data
    const mediaType =
      typeof entry.mimeType === 'string'
        ? entry.mimeType
        : typeof source?.media_type === 'string'
          ? source.media_type
          : undefined
    return cacheImage(data, mediaType)
  }
  if (entry.type !== 'resource' || !entry.resource || typeof entry.resource !== 'object') return null
  const resource = entry.resource as Record<string, unknown>
  if (typeof resource.blob !== 'string') return null
  const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : undefined
  return mimeType?.startsWith('image/') ? cacheImage(resource.blob, mimeType) : null
}

function isMcpImageEntry(entry: Record<string, unknown>): boolean {
  if (entry.type === 'image') return true
  if (entry.type !== 'resource' || !entry.resource || typeof entry.resource !== 'object') return false
  const resource = entry.resource as Record<string, unknown>
  return (
    typeof resource.blob === 'string' && typeof resource.mimeType === 'string' && resource.mimeType.startsWith('image/')
  )
}

export function toolImageOmissionNote(count: number): string {
  return `[${count} tool image${count === 1 ? '' : 's'} omitted: per-result image limit or cache budget]`
}

/** Converts an MCP CallToolResult while preserving text, images, structured content and isError. */
export function mcpResultToChatToolOutput(result: McpToolResultLike): ChatToolOutput {
  const entries = Array.isArray(result.content) ? result.content : []
  const text: string[] = []
  const images: ChatToolImage[] = []
  let imageEntries = 0
  let omittedImages = 0
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (isMcpImageEntry(entry)) {
      if (imageEntries >= MAX_TOOL_IMAGES_PER_RESULT) {
        omittedImages++
      } else {
        imageEntries++
        const image = imageFromMcpEntry(entry)
        if (image) images.push(image)
        else omittedImages++
      }
    }
    const line = recordText(entry)
    if (line) text.push(line)
  }
  const structuredContent = safeStructuredContent(result.structuredContent)
  const structuredText = stringifyStructured(structuredContent)
  if (structuredText) text.push(`Structured content:\n${structuredText}`)
  if (omittedImages > 0) text.push(toolImageOmissionNote(omittedImages))
  if (result.isError === true && text.length === 0) text.push('Tool reported an error.')
  return {
    text: text.join('\n') || (images.length ? '(image output)' : '(no output)'),
    ...(images.length ? { images } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  }
}

function attachMetadata(output: ToolResultOutput, chatOutput: ChatToolOutput): ToolResultOutput {
  Object.defineProperty(output, MAESTRLY_TOOL_OUTPUT_METADATA, {
    configurable: true,
    enumerable: false,
    value: chatOutput,
  })
  return output
}

export function chatToolOutputToAiSdkOutput(
  output: ToolOutput,
  options: { dropImages?: boolean } = {}
): ToolResultOutput {
  if (typeof output === 'string') return { type: 'text', value: output || '(no output)' }
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string; filename?: string }
  > = []
  if (output.text) content.push({ type: 'text', text: output.text })
  const images = toolOutputImages(output)
  for (const image of images.slice(0, MAX_TOOL_IMAGES_PER_RESULT)) {
    if (options.dropImages) {
      content.push({ type: 'text', text: toolImageTextForModel(image) })
      continue
    }
    const resolved = resolveEphemeralToolImage(image)
    if (!resolved) {
      content.push({ type: 'text', text: `[image output unavailable: ${image.name ?? image.id}]` })
      continue
    }
    content.push({
      type: 'file',
      data: { type: 'data', data: resolved.data },
      mediaType: resolved.mediaType,
      ...(image.name ? { filename: image.name } : {}),
    })
  }
  if (images.length > MAX_TOOL_IMAGES_PER_RESULT) {
    content.push({ type: 'text', text: toolImageOmissionNote(images.length - MAX_TOOL_IMAGES_PER_RESULT) })
  }
  const base: ToolResultOutput = output.isError
    ? content.length === 1 && content[0].type === 'text'
      ? { type: 'error-text', value: content[0].text }
      : { type: 'content', value: content }
    : content.length === 0
      ? { type: 'text', value: '(no output)' }
      : content.length === 1 && content[0].type === 'text'
        ? { type: 'text', value: content[0].text }
        : { type: 'content', value: content }
  return attachMetadata(base, output)
}

export function mcpResultToAiSdkOutput(result: McpToolResultLike): ToolResultOutput | string {
  const output = mcpResultToChatToolOutput(result)
  const hasStructured = output.structuredContent !== undefined
  const hasImages = toolOutputImages(output).length > 0
  if (!hasStructured && !hasImages && !output.isError) return output.text
  return chatToolOutputToAiSdkOutput(output)
}

function metadataFromModelOutput(output: unknown): ChatToolOutput | undefined {
  if (!output || typeof output !== 'object') return undefined
  const candidate = output as Record<string, unknown>
  const value = candidate[MAESTRLY_TOOL_OUTPUT_METADATA]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as ChatToolOutput
}

/** Removes host-only canonical metadata before a provider bridge re-normalizes a model projection. */
export function stripToolOutputMetadata(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  if (!Object.hasOwn(output, MAESTRLY_TOOL_OUTPUT_METADATA)) return output
  const clone = { ...(output as Record<string, unknown>) }
  delete clone[MAESTRLY_TOOL_OUTPUT_METADATA]
  return clone
}

function contentData(value: unknown): { data: string; mediaType: string; name?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  if (entry.type !== 'file' && entry.type !== 'file-data') return null
  const data =
    entry.type === 'file-data' ? entry.data : ((entry.data as Record<string, unknown> | undefined)?.data ?? entry.data)
  const cached = cacheImage(data, typeof entry.mediaType === 'string' ? entry.mediaType : undefined, {
    name: typeof entry.filename === 'string' ? entry.filename : undefined,
  })
  if (!cached) return null
  return { data: cached.id, mediaType: cached.mediaType, name: cached.name }
}

/** Normalizes any AI SDK tool result into the safe state representation. */
export function modelOutputToChatToolOutput(output: unknown): ToolOutput {
  const metadata = metadataFromModelOutput(output)
  if (metadata) return metadata
  if (typeof output === 'string') return output
  if (!output || typeof output !== 'object') return String(output ?? '(no output)')
  const candidate = output as Record<string, unknown>
  if (typeof candidate.text === 'string') {
    if (
      !Array.isArray(candidate.images) &&
      candidate.structuredContent === undefined &&
      candidate.isError === undefined
    ) {
      return candidate.text
    }
    const images = Array.isArray(candidate.images)
      ? candidate.images.filter(
          (image): image is ChatToolImage =>
            Boolean(image) &&
            typeof image === 'object' &&
            typeof (image as { id?: unknown }).id === 'string' &&
            typeof (image as { mediaType?: unknown }).mediaType === 'string'
        )
      : []
    const structuredContent = safeStructuredContent(candidate.structuredContent)
    return {
      text: candidate.text,
      ...(images.length ? { images } : {}),
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      ...(candidate.isError === true ? { isError: true } : {}),
    }
  }
  // Provider bridges sometimes wrap an otherwise textual result under `content` or `output`
  // without using an AI SDK discriminant. Keep that legacy projection textual before looking for MCP blocks.
  if (typeof candidate.content === 'string') return candidate.content
  if (typeof candidate.output === 'string') return candidate.output
  if (Array.isArray(candidate.content)) {
    return mcpResultToChatToolOutput(candidate)
  }
  if (candidate.type === 'text' || candidate.type === 'error-text') {
    const text = typeof candidate.value === 'string' ? candidate.value : '(no output)'
    return candidate.type === 'error-text' ? { text, isError: true } : text
  }
  if (candidate.type === 'content' && Array.isArray(candidate.value)) {
    const text: string[] = []
    const images: ChatToolImage[] = []
    for (const entry of candidate.value) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      if (item.type === 'text' && typeof item.text === 'string') text.push(item.text)
      const image = contentData(item)
      if (image)
        images.push({ id: image.data, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })
    }
    return {
      text: text.join('\n') || (images.length ? '(image output)' : '(no output)'),
      ...(images.length ? { images } : {}),
    }
  }
  if (candidate.type === 'json' || candidate.type === 'error-json') {
    const safe = safeStructuredContent(candidate.value)
    return {
      text: stringifyStructured(safe) || '(no output)',
      ...(safe !== undefined ? { structuredContent: safe } : {}),
      ...(candidate.type === 'error-json' ? { isError: true } : {}),
    }
  }
  try {
    return JSON.stringify(output) || '(no output)'
  } catch {
    return String(output)
  }
}

export function toolOutputAsText(output: ToolOutput | undefined): string {
  return toolOutputText(output) || '(no output)'
}

export function toolOutputIsError(output: ToolOutput | undefined): boolean {
  return typeof output === 'object' && output !== null && output.isError === true
}

export interface CodexToolContentText {
  type: 'inputText'
  text: string
}
export interface CodexToolContentImage {
  type: 'inputImage'
  imageUrl: string
}
export type CodexToolContentItem = CodexToolContentText | CodexToolContentImage

export function toolOutputToCodexContentItems(output: ToolOutput): CodexToolContentItem[] {
  const items: CodexToolContentItem[] = [{ type: 'inputText', text: toolOutputAsText(output) }]
  for (const image of toolOutputImages(output)) {
    const resolved = resolveEphemeralToolImage(image)
    if (resolved) items.push({ type: 'inputImage', imageUrl: `data:${resolved.mediaType};base64,${resolved.data}` })
  }
  return items
}

export function codexContentItemsToChatToolOutput(items: unknown, isError = false): ToolOutput {
  if (!Array.isArray(items)) return isError ? { text: '(no output)', isError: true } : '(no output)'
  const text: string[] = []
  const images: ChatToolImage[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (item.type === 'inputText' && typeof item.text === 'string') text.push(item.text)
    if (item.type === 'inputImage') {
      const image = cacheImage(item.imageUrl, typeof item.mediaType === 'string' ? item.mediaType : undefined)
      if (image) images.push(image)
    }
  }
  if (!images.length && !isError) return text.join('\n') || '(no output)'
  return {
    text: text.join('\n') || (images.length ? '(image output)' : '(no output)'),
    ...(images.length ? { images } : {}),
    ...(isError ? { isError: true } : {}),
  }
}

export function toolOutputToMcpCallResult(
  output: unknown,
  options: { isError?: boolean } = {}
): {
  content: Array<Record<string, unknown>>
  isError?: boolean
  structuredContent?: JSONValue
} {
  const normalized = modelOutputToChatToolOutput(output)
  const isError = options.isError ?? toolOutputIsError(normalized)
  const content: Array<Record<string, unknown>> = []
  const text = toolOutputAsText(normalized)
  if (text) content.push({ type: 'text', text })
  for (const image of toolOutputImages(normalized)) {
    const resolved = resolveEphemeralToolImage(image)
    if (resolved) content.push({ type: 'image', data: resolved.data, mimeType: resolved.mediaType })
  }
  return {
    content,
    ...(isError ? { isError: true } : {}),
    ...(typeof normalized === 'object' && normalized.structuredContent !== undefined
      ? { structuredContent: normalized.structuredContent }
      : {}),
  }
}

export function toolOutputToCopilotResult(
  output: unknown,
  options: { isError?: boolean } = {}
): {
  textResultForLlm: string
  resultType: 'success' | 'failure'
  binaryResultsForLlm?: Array<{ data: string; mimeType: string; type: 'image' | 'resource'; description?: string }>
  error?: string
} {
  const normalized = modelOutputToChatToolOutput(output)
  const isError = options.isError ?? toolOutputIsError(normalized)
  const text = toolOutputAsText(normalized)
  const binaryResultsForLlm = toolOutputImages(normalized)
    .map((image) => {
      const resolved = resolveEphemeralToolImage(image)
      return resolved
        ? {
            data: resolved.data,
            mimeType: resolved.mediaType,
            type: 'image' as const,
            ...(image.description ? { description: image.description } : {}),
          }
        : null
    })
    .filter((image): image is NonNullable<typeof image> => image != null)
  return {
    textResultForLlm: text,
    resultType: isError ? 'failure' : 'success',
    ...(binaryResultsForLlm.length ? { binaryResultsForLlm } : {}),
    ...(isError ? { error: text } : {}),
  }
}

export function copilotResultToChatToolOutput(result: unknown, success = true): ToolOutput {
  if (typeof result === 'string') return success ? result : { text: result, isError: true }
  if (!result || typeof result !== 'object') return success ? '(no output)' : { text: '(no output)', isError: true }
  const value = result as Record<string, unknown>
  const text =
    (typeof value.textResultForLlm === 'string' && value.textResultForLlm) ||
    (typeof value.content === 'string' && value.content) ||
    (typeof value.detailedContent === 'string' && value.detailedContent) ||
    (typeof value.error === 'string' && value.error) ||
    '(no output)'
  const images: ChatToolImage[] = []
  const binary = Array.isArray(value.binaryResultsForLlm) ? value.binaryResultsForLlm : []
  for (const raw of binary) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const image = cacheImage(item.data, typeof item.mimeType === 'string' ? item.mimeType : undefined, {
      description: typeof item.description === 'string' ? item.description : undefined,
    })
    if (image) images.push(image)
  }
  if (!images.length && success) return text
  return { text, ...(images.length ? { images } : {}), ...(!success ? { isError: true } : {}) }
}
