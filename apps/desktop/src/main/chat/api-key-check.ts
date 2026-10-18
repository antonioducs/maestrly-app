/**
 * Outcome of the last API-key check per provider, taken from the model listing (`GET {baseURL}/models`).
 *
 * The listing used to swallow every failure, so a key the provider refused looked connected and its models simply
 * did not appear. Only 401/403 mark a key as rejected; network failures, timeouts and providers without `/models`
 * leave it unverified, since they say nothing about the key. Entries are bound to the key fingerprint that models.ts
 * computes, so a new key starts unchecked, and the provider detail is redacted before it is stored or sent to the
 * renderer.
 */
import { APICallError } from '@ai-sdk/provider'
import type { ChatProviderKeyCheck, ChatProviderKeyCheckOutcome } from '../../shared/chat'
import { getAppSetting, setAppSetting } from '../store'
import { describeProviderError } from './provider-error'

interface StoredKeyCheck extends ChatProviderKeyCheck {
  /** Key fingerprint (sha256[0:16]); never the key itself. */
  fp: string
}

const PERSIST_KEY = 'chat.apiKeyChecks'
const OUTCOMES: readonly ChatProviderKeyCheckOutcome[] = ['accepted', 'rejected', 'unverified']
const checks = new Map<string, StoredKeyCheck>()
let seeded = false

function seedFromDisk(): void {
  if (seeded) return
  seeded = true
  try {
    const raw = getAppSetting(PERSIST_KEY)
    if (!raw) return
    for (const [id, entry] of Object.entries(JSON.parse(raw) as Record<string, Partial<StoredKeyCheck>>)) {
      if (
        typeof entry?.fp !== 'string' ||
        typeof entry.checkedAt !== 'number' ||
        !OUTCOMES.includes(entry.outcome as ChatProviderKeyCheckOutcome)
      ) {
        continue
      }
      checks.set(id, {
        fp: entry.fp,
        checkedAt: entry.checkedAt,
        outcome: entry.outcome as ChatProviderKeyCheckOutcome,
        ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
        ...(typeof entry.detail === 'string' && entry.detail ? { detail: entry.detail } : {}),
      })
    }
  } catch {
    // Corrupt entry: the next listing checks again.
  }
}

function persist(): void {
  try {
    setAppSetting(PERSIST_KEY, JSON.stringify(Object.fromEntries(checks)))
  } catch {
    // Best effort: the in-memory result still serves this session.
  }
}

export function isRejectedKeyStatus(status: number): boolean {
  return status === 401 || status === 403
}

/** Check from a `/models` response the provider sent; `body` is its raw text, read only when it failed. */
export function keyCheckFromResponse(
  url: string,
  status: number,
  body: string,
  context: { providerName?: string; apiKey: string }
): Omit<ChatProviderKeyCheck, 'checkedAt'> {
  if (status >= 200 && status < 300) return { outcome: 'accepted' }
  const error = new APICallError({ message: '', url, requestBodyValues: {}, statusCode: status, responseBody: body })
  const { detail } = describeProviderError(error, { providerName: context.providerName, secrets: [context.apiKey] })
  return { outcome: isRejectedKeyStatus(status) ? 'rejected' : 'unverified', status, ...(detail ? { detail } : {}) }
}

/** Check from a listing that got no answer (network failure, timeout). */
export function keyCheckFromFailure(error: unknown, apiKey: string): Omit<ChatProviderKeyCheck, 'checkedAt'> {
  const { detail } = describeProviderError(error, { secrets: [apiKey] })
  return { outcome: 'unverified', ...(detail ? { detail } : {}) }
}

/** Records the check of the key whose fingerprint is `fp`; an empty fingerprint means no key, so nothing to check. */
export function recordApiKeyCheck(
  providerId: string,
  fp: string,
  check: Omit<ChatProviderKeyCheck, 'checkedAt'>
): void {
  if (!fp) return
  seedFromDisk()
  checks.set(providerId, { ...check, fp, checkedAt: Date.now() })
  persist()
}

/** The last check of exactly the key whose fingerprint is `fp`, or undefined when it has not been checked. */
export function getApiKeyCheck(providerId: string, fp: string): ChatProviderKeyCheck | undefined {
  if (!fp) return undefined
  seedFromDisk()
  const entry = checks.get(providerId)
  if (!entry || entry.fp !== fp) return undefined
  const { fp: _fp, ...check } = entry
  return check
}

/** Forgets checks after a key, endpoint or provider change: memory and disk. */
export function clearApiKeyCheck(providerId?: string): void {
  seedFromDisk()
  if (providerId) {
    if (!checks.delete(providerId)) return
  } else {
    if (checks.size === 0) return
    checks.clear()
  }
  persist()
}
