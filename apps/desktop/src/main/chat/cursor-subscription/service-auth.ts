import type { ChatSubscriptionAuthStatus } from '../../../shared/chat'
import { cursorSdkErrorMessage } from '../cursor-sdk/errors'
import { isCursorSdkPlatformSupported } from '../cursor-sdk/platform'
import { getCursorSubscriptionManager, listCursorSubscriptionManagers, type CursorSubscriptionStatus } from './manager'

type AccountId = string | null
interface AccountState {
  busy: boolean
  generation: number
  fingerprint?: string | null
  refresh?: Promise<ChatSubscriptionAuthStatus>
  transition?: Promise<void>
  unsubscribe?: () => void
}

export function cursorPublicAuthStatus(status: CursorSubscriptionStatus): ChatSubscriptionAuthStatus {
  if (!status.available || status.state === 'disposed') return { state: 'unavailable', authenticated: false }
  if (status.authenticated)
    return {
      state: 'signed-in',
      authenticated: true,
      storageMode: status.storageMode,
      email: status.account?.email ?? undefined,
      username: status.account?.apiKeyName ?? undefined,
    }
  if (status.state === 'error')
    return {
      state: 'error',
      authenticated: false,
      error: status.error?.message,
      errorCode: status.error?.code as ChatSubscriptionAuthStatus['errorCode'],
    }
  return { state: 'signed-out', authenticated: false }
}

/** Owns authentication transitions independently for every account. Snapshots never create a manager. */
export class CursorServiceAuth {
  private readonly accounts = new Map<AccountId, AccountState>()
  constructor(
    private readonly hooks: {
      reset: (accountId: AccountId) => Promise<void>
      broadcast: (status: ChatSubscriptionAuthStatus) => void
    }
  ) {}

  private state(accountId: AccountId): AccountState {
    let state = this.accounts.get(accountId)
    if (!state) {
      state = { busy: false, generation: 0 }
      this.accounts.set(accountId, state)
    }
    return state
  }

  busy(accountId: AccountId): boolean {
    const state = this.accounts.get(accountId)
    return !!(state?.busy || state?.transition)
  }

  snapshot(accountId: AccountId = null): ChatSubscriptionAuthStatus {
    if (!isCursorSdkPlatformSupported()) return { state: 'unavailable', authenticated: false }
    if (this.busy(accountId)) return { state: 'signing-in', authenticated: false }
    const snapshot = listCursorSubscriptionManagers()
      .find((manager) => manager.accountId === accountId)
      ?.getStatusSnapshot()
    return snapshot ? cursorPublicAuthStatus(snapshot) : { state: 'signed-out', authenticated: false }
  }

  private publish(accountId: AccountId, status: ChatSubscriptionAuthStatus): void {
    this.hooks.broadcast(accountId ? { ...status, accountId } : status)
  }

  private manager(accountId: AccountId) {
    const manager = getCursorSubscriptionManager(accountId)
    const state = this.state(accountId)
    state.unsubscribe ??= manager.onAuthUpdated(() => {
      if (this.busy(accountId)) return
      state.generation++
      const transition = this.hooks
        .reset(accountId)
        .then(async () => {
          const status = await manager.getStatus(true)
          state.fingerprint = status.accountFingerprint
          this.publish(accountId, cursorPublicAuthStatus(status))
        })
        .catch((error) =>
          this.publish(accountId, {
            state: 'error',
            authenticated: false,
            error: cursorSdkErrorMessage(error),
          })
        )
      state.transition = transition
      void transition.finally(() => {
        if (state.transition === transition) state.transition = undefined
      })
    })
    return manager
  }

  async status(refresh = false, accountId: AccountId = null): Promise<ChatSubscriptionAuthStatus> {
    if (!isCursorSdkPlatformSupported()) return { state: 'unavailable', authenticated: false }
    if (this.busy(accountId)) return { state: 'signing-in', authenticated: false }
    const state = this.state(accountId)
    if (state.refresh) return state.refresh
    const manager = this.manager(accountId)
    const generation = state.generation
    const pending = (async () => {
      const status = await manager.getStatus(refresh)
      if (generation !== state.generation || this.busy(accountId)) return this.snapshot(accountId)
      if (state.fingerprint && state.fingerprint !== status.accountFingerprint) {
        // A status refresh can run inside compaction. Abort synchronously, but do not
        // await the same active turn whose completion the reset must drain.
        const transition = this.hooks.reset(accountId).catch((error) => {
          this.publish(accountId, { state: 'error', authenticated: false, error: cursorSdkErrorMessage(error) })
        })
        state.transition = transition
        void transition.finally(() => {
          if (state.transition === transition) state.transition = undefined
        })
        state.fingerprint = status.accountFingerprint
        return { state: 'signing-in' as const, authenticated: false }
      }
      state.fingerprint = status.accountFingerprint
      return cursorPublicAuthStatus(status)
    })()
    state.refresh = pending
    try {
      return await pending
    } finally {
      if (state.refresh === pending) state.refresh = undefined
    }
  }

  async login(accountId: AccountId = null) {
    if (!isCursorSdkPlatformSupported()) return { ok: false, error: 'unavailable' }
    if (this.busy(accountId)) return { ok: false, error: 'busy' }
    const state = this.state(accountId)
    const generation = ++state.generation
    state.busy = true
    this.publish(accountId, { state: 'signing-in', authenticated: false })
    const manager = this.manager(accountId)
    try {
      await this.hooks.reset(accountId)
      if (state.generation !== generation) return { ok: false, error: 'superseded' }
      const attempt = await manager.startLogin()
      if (state.generation !== generation) {
        manager.cancelLogin(attempt.loginId)
        return { ok: false, error: 'superseded' }
      }
      void manager
        .waitForLogin(attempt.loginId)
        .then(async (completion) => {
          if (state.generation !== generation) return
          if (!completion.success) throw new Error(completion.error?.message ?? 'Cursor login failed')
          const status = await manager.getStatus(true)
          if (state.generation !== generation) return
          state.fingerprint = status.accountFingerprint
          state.busy = false
          this.publish(accountId, cursorPublicAuthStatus(status))
        })
        .catch((error) => {
          if (state.generation === generation) {
            state.busy = false
            this.publish(accountId, {
              state: 'error',
              authenticated: false,
              error: cursorSdkErrorMessage(error),
            })
          }
        })
        .finally(() => {
          if (state.generation === generation) state.busy = false
        })
      return {
        ok: true,
        authUrl: attempt.loginUrl || undefined,
        status: { state: 'signing-in' as const, authenticated: false },
      }
    } catch (error) {
      if (state.generation !== generation) return { ok: false, error: 'superseded' }
      state.busy = false
      const message = cursorSdkErrorMessage(error)
      this.publish(accountId, {
        state: 'error',
        authenticated: false,
        error: message,
      })
      return { ok: false, error: message }
    }
  }

  async logout(accountId: AccountId = null) {
    const state = this.state(accountId)
    while (state.transition) await state.transition
    state.generation++
    state.busy = true
    const manager = this.manager(accountId)
    manager.cancelPendingLogins()
    const operation = (async () => {
      try {
        await this.hooks.reset(accountId)
        await manager.logout()
        state.fingerprint = null
        const status = cursorPublicAuthStatus(await manager.getStatus(true))
        this.publish(accountId, status)
        return { ok: true, status }
      } catch (error) {
        return { ok: false, error: cursorSdkErrorMessage(error) }
      } finally {
        state.busy = false
      }
    })()
    const transition = operation.then(() => undefined)
    state.transition = transition
    try {
      return await operation
    } finally {
      if (state.transition === transition) state.transition = undefined
    }
  }

  async dispose(): Promise<void> {
    for (const [id, state] of this.accounts) {
      state.generation++
      state.unsubscribe?.()
      listCursorSubscriptionManagers()
        .find((manager) => manager.accountId === id)
        ?.cancelPendingLogins()
    }
    await Promise.allSettled(
      [...this.accounts.values()].flatMap((state) => [state.transition, state.refresh].filter(Boolean))
    )
    this.accounts.clear()
  }
}
