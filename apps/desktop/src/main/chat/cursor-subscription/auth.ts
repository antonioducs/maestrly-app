import { cursorSdkErrorMessage } from '../cursor-sdk/errors'
import type {
  CursorLoginAttempt,
  CursorLoginCompletion,
  CursorSubscriptionPublicError,
  CursorSubscriptionSdk,
} from './manager'

export class CursorSubscriptionAccountChangedError extends Error {
  constructor() {
    super('Cursor account changed while the operation was in progress')
    this.name = 'CursorSubscriptionAccountChangedError'
  }
}

export class CursorSubscriptionNotAuthenticatedError extends Error {
  constructor() {
    super('Cursor is not authenticated')
    this.name = 'CursorSubscriptionNotAuthenticatedError'
  }
}

const FILESYSTEM_SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/

export function validateCursorAccountId(accountId: string | null): void {
  if (accountId && !FILESYSTEM_SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Invalid Cursor subscription account id: ${accountId}`)
  }
}

export function cursorIdentityFingerprint(me: { userId?: number; userEmail?: string }): string | null {
  if (typeof me.userId === 'number') return `user:${me.userId}`
  if (typeof me.userEmail === 'string' && me.userEmail.trim()) return `email:${me.userEmail.trim()}`
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function publicError(error: unknown): CursorSubscriptionPublicError {
  const record = isRecord(error) ? error : null
  const rawCode = record?.code ?? record?.status
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined
  return { ...(code !== undefined ? { code } : {}), message: cursorSdkErrorMessage(error) }
}

/** Cancellation settles locally; late SDK results remain observed but cannot commit. */
function withLoginCancellation<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const onAbort = (): void => reject(new Error('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
  })
}

export function loginWithCursorSdk(
  sdk: CursorSubscriptionSdk,
  signal: AbortSignal,
  onLoginUrl: (url: string) => void
): Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }> {
  return withLoginCancellation(signal, () =>
    sdk.Cursor.auth.login({
      store: null,
      openBrowser: false,
      apiKeyName: 'Maestrly Chat',
      signal,
      onLoginUrl: (url: string) => {
        if (!signal.aborted) onLoginUrl(url)
      },
    })
  )
}

interface CursorLoginControllerOptions {
  resetPromise(): Promise<void> | null
  isDisposed(): boolean
  nextGeneration(): number
  generation(): number
  createLoginId(): string
  loadSdk(): Promise<CursorSubscriptionSdk>
  admitApiKey(
    key: string,
    options: {
      expectedLoginGeneration: number
      signal: AbortSignal
      apiKeyExpiresAtMs: number
    }
  ): Promise<void>
}

/** Owns browser attempts; admission remains guarded by the manager identity epoch. */
export class CursorLoginController {
  private readonly logins = new Map<
    string,
    { attempt: CursorLoginAttempt; controller: AbortController; promise: Promise<CursorLoginCompletion> }
  >()

  constructor(private readonly options: CursorLoginControllerOptions) {}

  async startLogin(): Promise<CursorLoginAttempt> {
    while (this.options.resetPromise()) await this.options.resetPromise()
    if (this.options.isDisposed()) throw new Error('Cursor subscription manager is disposed')
    const generation = this.options.nextGeneration()
    for (const record of this.logins.values()) {
      if (record.attempt.state === 'pending') record.controller.abort()
    }
    const controller = new AbortController()
    const loginId = this.options.createLoginId()
    let resolveUrl!: (attempt: CursorLoginAttempt) => void
    const urlKnown = new Promise<CursorLoginAttempt>((resolve) => {
      resolveUrl = resolve
    })
    const attempt: CursorLoginAttempt = { loginId, loginUrl: '', state: 'pending', completion: null }
    let settled = false

    const settleUrl = (): void => {
      if (settled) return
      settled = true
      resolveUrl({ ...attempt, completion: attempt.completion ? { ...attempt.completion } : null })
    }

    const promise = (async () => {
      try {
        const sdk = await withLoginCancellation(controller.signal, () => this.options.loadSdk())

        const result = await loginWithCursorSdk(sdk, controller.signal, (url) => {
          attempt.loginUrl = url
          settleUrl()
        })
        if (this.options.isDisposed() || generation !== this.options.generation() || controller.signal.aborted) {
          throw new Error('cancelled')
        }
        await withLoginCancellation(controller.signal, () =>
          this.options.admitApiKey(result.apiKey, {
            expectedLoginGeneration: generation,
            signal: controller.signal,
            apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
          })
        )
        attempt.state = 'succeeded'
        const completion = { loginId, success: true, error: null }
        attempt.completion = completion
        settleUrl()
        return completion
      } catch (error) {
        const cancelled =
          controller.signal.aborted ||
          (error instanceof Error && /cancel/i.test(error.message)) ||
          (isRecord(error) && String(error.name ?? '').includes('Cancel'))
        attempt.state = cancelled ? 'cancelled' : 'failed'
        const completion = { loginId, success: false, error: publicError(error) }
        attempt.completion = completion
        settleUrl()
        return completion
      }
    })()

    this.logins.set(loginId, { attempt, controller, promise })

    return urlKnown
  }

  getLoginAttempt(loginId: string): CursorLoginAttempt | null {
    const record = this.logins.get(loginId)
    return record
      ? { ...record.attempt, completion: record.attempt.completion ? { ...record.attempt.completion } : null }
      : null
  }

  waitForLogin(loginId: string): Promise<CursorLoginCompletion> {
    const record = this.logins.get(loginId)
    if (!record) return Promise.reject(new Error(`Unknown Cursor login attempt: ${loginId}`))
    return record.promise.then((completion) => ({ ...completion }))
  }

  cancelLogin(loginId: string): boolean {
    const record = this.logins.get(loginId)
    if (record?.attempt.state !== 'pending') return false
    record.controller.abort()
    return true
  }

  cancelPendingLogins(): void {
    for (const record of this.logins.values()) {
      if (record.attempt.state === 'pending') record.controller.abort()
    }
  }

  cancelAndClear(): Promise<CursorLoginCompletion>[] {
    this.cancelPendingLogins()
    const promises = [...this.logins.values()].map((record) => record.promise)
    this.logins.clear()
    return promises
  }
}
