import { MaestrlyClient } from '@maestrly/client-sdk'

export const serverUrl = (import.meta.env.VITE_MAESTRLY_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? ''
export const client = new MaestrlyClient({ baseUrl: serverUrl })

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  headers.set('x-maestrly-protocol-version', '1.0')
  if (init.body) headers.set('content-type', 'application/json')
  const response = await fetch(`${serverUrl}${path}`, { ...init, headers, credentials: 'include' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: `Request failed (${response.status})` })) as { message?: string; details?: unknown }
    throw Object.assign(new Error(body.message ?? `Request failed (${response.status})`), { status: response.status, details: body.details })
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const write = <T>(path: string, method: string, body: unknown, key = crypto.randomUUID()) => api<T>(path, {
  method,
  body: JSON.stringify(body),
  headers: { 'idempotency-key': key },
})
