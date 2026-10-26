// What the viewer makes of the host's answers about a response, before telling the page.
import { isResponseData, type ResponseError, type ResponseSnapshot } from './contract.js'

/** Why the host refused a response, as the page learns it. */
export function responseError(status: number | null, error: unknown): ResponseError {
  if (status === 403 && error === 'responses_closed') return 'closed'
  if (status === 409 && error === 'too_many_responses') return 'full'
  if (status === 413) return 'too_large'
  if (status === 400) return 'invalid'
  if (status === 429) return 'rate_limited'
  if (status === 404) return 'unavailable'
  return 'failed'
}

/** The host's answer, checked: a snapshot, null when there is none, or undefined when it is malformed. */
export function readSnapshot(body: unknown): ResponseSnapshot | null | undefined {
  if (typeof body !== 'object' || body === null || !('response' in body)) return undefined
  const response = (body as { response: unknown }).response
  if (response === null) return null
  if (typeof response !== 'object') return undefined
  const { data, version, updatedAt } = response as Record<string, unknown>
  if (!isResponseData(data)) return undefined
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return undefined
  return { data, version, updatedAt }
}
