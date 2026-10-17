import type {
  ChatSubscriptionAuthStatus,
  ChatSubscriptionLoginResult,
  ChatSubscriptionLogoutResult,
} from '../../../shared/chat'
import { antigravityErrorMessage } from './errors'
import { type AntigravitySubscriptionManager, getAntigravitySubscriptionManager } from './manager'

type AccountId = string | null

/** The browser flow is abandoned (and its process killed) if Google never redirects back. */
const LOGIN_TIMEOUT_MS = 10 * 60_000

interface AccountState {
  generation: number
  transition: Promise<void> | null
  /** Google's sign-in page for the pending transition, shown so it can be copied when no browser opened. */
  authUrl?: string
  unsubscribe?: () => void
}

export interface AntigravityServiceAuthHooks {
  /** Aborts this account's turns and forgets its sessions before its identity changes. */
  reset(accountId: AccountId): Promise<void>
  /** Installs the managed ACP server when needed (explicit sign-in is the only install trigger). */
  ensureRuntime(signal: AbortSignal): Promise<void>
  broadcast(status: ChatSubscriptionAuthStatus): void
  /**
   * Opens the captured sign-in page in the user's browser. The server runs with a private `HOME`, so on Linux its
   * own `xdg-open` would miss the user's browser settings; Google also refuses embedded browsers.
   */
  openBrowser?(url: string): void
  manager?: (accountId: AccountId) => AntigravitySubscriptionManager
  platform?: NodeJS.Platform
}

/**
 * Account transitions for the Google AI subscription. Sign-in returns immediately with `signing-in` and finishes in
 * the background, because the ACP `authenticate` call blocks until the user completes Google's page.
 */
export class AntigravityServiceAuth {
  private readonly accounts = new Map<AccountId, AccountState>()
  private disposed = false

  constructor(private readonly hooks: AntigravityServiceAuthHooks) {}

  busy(accountId: AccountId): boolean {
    return Boolean(this.accounts.get(accountId)?.transition)
  }

  status(accountId: AccountId = null): ChatSubscriptionAuthStatus {
    if (this.busy(accountId)) return this.signingIn(this.accounts.get(accountId))
    return this.manager(accountId).getStatus()
  }

  login(accountId: AccountId = null): ChatSubscriptionLoginResult {
    if (this.disposed) return { ok: false, error: 'unavailable' }
    if (this.busy(accountId)) return { ok: false, error: 'busy' }
    const state = this.state(accountId)
    const generation = ++state.generation
    const manager = this.manager(accountId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Google sign-in timed out.')), LOGIN_TIMEOUT_MS)
    timer.unref?.()
    state.authUrl = undefined
    const signingIn = this.signingIn(state)
    this.publish(accountId, signingIn)
    // The capture shim is a POSIX shell script; on Windows the server opens the default browser itself.
    const openBrowser = this.hooks.openBrowser
    const onBrowserUrl =
      openBrowser && (this.hooks.platform ?? process.platform) !== 'win32'
        ? (url: string) => {
            if (generation !== state.generation) return
            state.authUrl = url
            openBrowser(url)
            this.publish(accountId, this.signingIn(state))
          }
        : undefined
    // Assigned before the first await inside, so `finish` always sees the right promise.
    let transition!: Promise<void>
    transition = (async () => {
      try {
        await this.hooks.reset(accountId)
        await this.hooks.ensureRuntime(controller.signal)
        const result = await manager.login(controller.signal, onBrowserUrl)
        if (generation !== state.generation) return
        // Release the busy flag first so the broadcast status is the account's real state.
        this.finish(accountId, transition)
        this.publish(
          accountId,
          result.ok
            ? manager.getStatus()
            : { state: 'error', authenticated: false, error: result.error ?? 'Google sign-in did not complete.' }
        )
      } catch (error) {
        if (generation !== state.generation) return
        this.finish(accountId, transition)
        this.publish(accountId, { state: 'error', authenticated: false, error: antigravityErrorMessage(error).message })
      } finally {
        clearTimeout(timer)
        this.finish(accountId, transition)
      }
    })()
    state.transition = transition
    void transition.catch(() => undefined)
    return { ok: true, status: signingIn }
  }

  async logout(accountId: AccountId = null): Promise<ChatSubscriptionLogoutResult> {
    const state = this.state(accountId)
    state.generation++
    const manager = this.manager(accountId)
    // Signing out while the browser flow is open cancels it.
    manager.cancelLogin()
    await state.transition?.catch(() => undefined)
    try {
      await this.hooks.reset(accountId)
      await manager.logout()
      const status = manager.getStatus()
      this.publish(accountId, status)
      return { ok: true, status }
    } catch (error) {
      const message = antigravityErrorMessage(error).message
      this.publish(accountId, { state: 'error', authenticated: false, error: message })
      return { ok: false, error: message }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [accountId, state] of this.accounts) {
      state.unsubscribe?.()
      if (state.transition) this.manager(accountId).cancelLogin()
    }
  }

  private state(accountId: AccountId): AccountState {
    let state = this.accounts.get(accountId)
    if (!state) {
      state = { generation: 0, transition: null }
      this.accounts.set(accountId, state)
    }
    return state
  }

  private finish(accountId: AccountId, transition: Promise<void>): void {
    const state = this.accounts.get(accountId)
    if (state && (state.transition === transition || state.transition === null)) {
      state.transition = null
      state.authUrl = undefined
    }
  }

  private signingIn(state: AccountState | undefined): ChatSubscriptionAuthStatus {
    return { state: 'signing-in', authenticated: false, ...(state?.authUrl ? { authUrl: state.authUrl } : {}) }
  }

  private manager(accountId: AccountId): AntigravitySubscriptionManager {
    const manager = (this.hooks.manager ?? getAntigravitySubscriptionManager)(accountId)
    const state = this.state(accountId)
    // Runtime auth failures (an expired sign-in) reach the settings card without polling.
    state.unsubscribe ??= manager.onAuthChanged(() => {
      if (!this.busy(accountId)) this.publish(accountId, manager.getStatus())
    })
    return manager
  }

  private publish(accountId: AccountId, status: ChatSubscriptionAuthStatus): void {
    this.hooks.broadcast(accountId ? { ...status, accountId } : status)
  }
}
