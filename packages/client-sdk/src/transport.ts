import { apiErrorSchema, type ApiError } from '@maestrly/protocol'

export interface AuthenticationProvider {
  headers(): Promise<Record<string, string>> | Record<string, string>
}

export interface TransportOptions {
  baseUrl: string
  authentication?: AuthenticationProvider
  fetch?: typeof globalThis.fetch
  protocolVersion?: string
}

export interface RequestOptions {
  body?: unknown
  headers?: Record<string, string>
  idempotencyKey?: string
  signal?: AbortSignal
}

export class MaestrlyApiError extends Error {
  readonly response: ApiError
  readonly status: number

  constructor(status: number, response: ApiError) {
    super(response.message)
    this.name = 'MaestrlyApiError'
    this.status = status
    this.response = response
  }
}

export class HttpTransport {
  readonly baseUrl: string
  private readonly authentication?: AuthenticationProvider
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly protocolVersion: string

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.authentication = options.authentication
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.protocolVersion = options.protocolVersion ?? '1.0'
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const authHeaders = await this.authentication?.headers() ?? {}
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-maestrly-protocol-version': this.protocolVersion,
      ...authHeaders,
      ...options.headers,
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'include',
    })
    if (!response.ok) {
      const raw = await response.json().catch(() => ({
        code: 'INTERNAL', message: `Request failed with status ${response.status}`, requestId: response.headers.get('x-request-id') ?? 'unknown',
      }))
      const parsed = apiErrorSchema.safeParse(raw)
      const error = parsed.success ? parsed.data : {
        code: 'INTERNAL' as const,
        message: `Request failed with status ${response.status}`,
        requestId: response.headers.get('x-request-id') ?? 'unknown',
      }
      throw new MaestrlyApiError(response.status, error)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return this.authenticationHeaders().then((authHeaders) => {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-maestrly-protocol-version': this.protocolVersion,
        ...authHeaders,
      }
      new Headers(init.headers).forEach((value, key) => { headers[key] = value })
      return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, credentials: 'include' })
    })
  }

  private async authenticationHeaders(): Promise<Record<string, string>> {
    return await this.authentication?.headers() ?? {}
  }
}
