import { randomUUID } from 'node:crypto'
import {
  FLEET_PROVISIONING_LIMITS,
  fleetLoginUrlAllowed,
  fleetLoginCallbackFromAuthUrl,
  type FleetLoginKind,
  type FleetLoginAttempt,
  type FleetLoginStartRequest,
  type FleetLoginCallbackRequest,
  type FleetLoginCallbackResponse,
} from '@maestrly/bot-fleet-protocol'
import type {
  CodexSubscriptionLoginAttempt,
  CodexSubscriptionLoginCompletion,
  CodexSubscriptionStatus,
} from '../../../chat/codex-subscription/manager'
import type {
  GrokLoginAttempt,
  GrokLoginCompletion,
  GrokSubscriptionStatus,
} from '../../../chat/grok-subscription/manager'
import type { ClaudeInteractiveLogin } from '../../../chat/claude-agent-sdk/manager'
import { InstanceHttpError } from '../server'
import type { forwardLoginCallback } from './callback-forwarder'

export const LOGIN_PROVIDER_NAMES: Record<FleetLoginKind, string> = { codex: 'Codex', claude: 'Claude', grok: 'Grok' }
export interface RemoteLoginDeps {
  now: () => number
  onChanged: () => void
  isConnected: (kind: FleetLoginKind, accountId: string | null) => boolean
  createSlot: (kind: FleetLoginKind) => string
  renameSlot: (accountId: string, label: string) => void
  removeSlot: (accountId: string) => Promise<void>
  slotExists: (kind: FleetLoginKind, accountId: string) => boolean
  codex: (accountId: string | null) => {
    startLogin(options: { method: 'browser' | 'device' }): Promise<CodexSubscriptionLoginAttempt>
    waitForLogin(id: string, options: { timeoutMs: number }): Promise<CodexSubscriptionLoginCompletion>
    cancelLogin(id: string): Promise<void>
    getStatus(): Promise<Pick<CodexSubscriptionStatus, 'account'>>
  }
  claude: (accountId: string | null) => { startInteractiveLogin(): Promise<ClaudeInteractiveLogin> }
  grok: (accountId: string | null) => {
    startLogin(method: 'device'): Promise<GrokLoginAttempt>
    waitForLogin(id: string): Promise<GrokLoginCompletion>
    cancelLogin(id: string): boolean
    getStatus(): Promise<Pick<GrokSubscriptionStatus, 'account'>>
  }
  forward: typeof forwardLoginCallback
}
interface Entry {
  attempt: FleetLoginAttempt
  createdSlot: boolean
  succeeded?: boolean
  settling?: boolean
  ready: Promise<void>
  releaseReady: () => void
  cancelProvider: () => void | Promise<void>
  submitCode?: (code: string) => void
  timer?: ReturnType<typeof setTimeout>
  terminal?: Promise<void>
}
export class RemoteLogins {
  private entries = new Map<string, Entry>()
  private disposed = false
  constructor(private readonly deps: RemoteLoginDeps) {}
  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new InstanceHttpError(404, 'NOT_FOUND', 'Sign-in attempt does not exist.')
    return entry
  }
  get(loginId: string): FleetLoginAttempt {
    return structuredClone(this.entry(loginId).attempt)
  }
  signingIn(): Array<{ kind: FleetLoginKind; accountId: string | null }> {
    return [...this.entries.values()]
      .filter((entry) => entry.attempt.state === 'pending')
      .map(({ attempt }) => ({ kind: attempt.kind, accountId: attempt.accountId }))
  }
  async start(request: FleetLoginStartRequest): Promise<FleetLoginAttempt> {
    if (this.disposed) throw new InstanceHttpError(409, 'CONFLICT', 'Bot sign-ins are shutting down.')
    const pending = [...this.entries.values()]
      .filter((entry) => entry.attempt.state === 'pending' || entry.settling)
      .map((entry) => entry.attempt)
    if (pending.length >= 3 || pending.some((attempt) => attempt.kind === request.kind))
      throw new InstanceHttpError(
        409,
        'CONFLICT',
        'Another ' + LOGIN_PROVIDER_NAMES[request.kind] + ' sign-in is in progress on this bot.'
      )
    let accountId: string | null = null
    let createdSlot = false
    if (request.slot === 'auto' && this.deps.isConnected(request.kind, null)) {
      accountId = this.deps.createSlot(request.kind)
      createdSlot = true
    } else if (request.slot !== 'auto' && request.slot !== 'default') {
      if (!this.deps.slotExists(request.kind, request.slot))
        throw new InstanceHttpError(404, 'NOT_FOUND', 'Account does not exist.')
      accountId = request.slot
    }
    let releaseReady!: () => void
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve
    })
    const attempt: FleetLoginAttempt = {
      loginId: randomUUID(),
      kind: request.kind,
      accountId,
      method: request.kind === 'claude' ? 'browser' : request.method,
      state: 'pending',
      expiresAt: new Date(this.deps.now() + FLEET_PROVISIONING_LIMITS.loginTtlMs).toISOString(),
      browser: null,
      device: null,
      manual: null,
      account: null,
      error: null,
    }
    const entry: Entry = { attempt, createdSlot, ready, releaseReady, cancelProvider: () => {} }
    this.entries.set(attempt.loginId, entry)
    entry.timer = setTimeout(() => {
      void this.finish(entry, 'expired')
    }, FLEET_PROVISIONING_LIMITS.loginTtlMs)
    entry.timer.unref()
    try {
      await this.startProvider(entry)
      releaseReady()
      if (attempt.state === 'pending') this.deps.onChanged()
      return this.get(attempt.loginId)
    } catch (error) {
      releaseReady()
      await this.finish(entry, 'failed', 'The provider could not start sign-in.')
      if (error instanceof InstanceHttpError) throw error
      throw new InstanceHttpError(502, 'INSTANCE_UNAVAILABLE', 'The provider could not start sign-in.')
    }
  }
  private validateUrl(kind: FleetLoginKind, url: string | null): string {
    if (!url || !fleetLoginUrlAllowed(kind, url))
      throw new InstanceHttpError(502, 'INSTANCE_UNAVAILABLE', 'The provider returned an unexpected sign-in address.')
    return url
  }
  private browser(kind: FleetLoginKind, url: string | null): NonNullable<FleetLoginAttempt['browser']> {
    const authUrl = this.validateUrl(kind, url)
    const callback = fleetLoginCallbackFromAuthUrl(authUrl)
    if (!callback)
      throw new InstanceHttpError(502, 'INSTANCE_UNAVAILABLE', 'The provider returned an unexpected sign-in address.')
    return { authUrl, callback }
  }
  private async startProvider(entry: Entry): Promise<void> {
    const { attempt } = entry
    if (attempt.kind === 'claude') {
      const login = await this.deps.claude(attempt.accountId).startInteractiveLogin()
      entry.cancelProvider = () => login.cancel()
      entry.submitCode = (code) => login.submitCode(code)
      attempt.browser = this.browser('claude', login.autoUrl)
      attempt.manual = { url: this.validateUrl('claude', login.manualUrl) }
      void login.done
        .then(async (result) => {
          if (!result.ok) await this.finish(entry, 'failed', result.error ?? 'Claude sign-in failed.')
          else
            await this.complete(entry, {
              label: 'Claude',
              email: result.status.account?.email ?? null,
              plan: result.status.account?.subscriptionType ?? null,
            })
        })
        .catch(() => this.finish(entry, 'failed', 'Claude sign-in failed.'))
    } else if (attempt.kind === 'codex') {
      const manager = this.deps.codex(attempt.accountId)
      const login = await manager.startLogin({ method: attempt.method })
      entry.cancelProvider = () => manager.cancelLogin(login.loginId)
      if (attempt.method === 'browser') attempt.browser = this.browser('codex', login.authUrl)
      else
        attempt.device = {
          verificationUrl: this.validateUrl('codex', login.verificationUrl),
          userCode: this.userCode(login.userCode),
        }
      void manager
        .waitForLogin(login.loginId, { timeoutMs: FLEET_PROVISIONING_LIMITS.loginTtlMs })
        .then(async (result) => {
          if (entry.attempt.state !== 'pending') return
          if (!result.success) return this.finish(entry, 'failed', result.error ?? 'Codex sign-in failed.')
          entry.succeeded = true
          clearTimeout(entry.timer)
          const { account } = await manager.getStatus().catch(() => ({ account: null }))
          await this.complete(entry, {
            label: 'Codex',
            email: account?.type === 'chatgpt' ? account.email : null,
            plan: account?.type === 'chatgpt' ? account.planType : null,
          })
        })
        .catch(() => this.finish(entry, 'failed', 'Codex sign-in failed.'))
    } else {
      const manager = this.deps.grok(attempt.accountId)
      const login = await manager.startLogin('device')
      entry.cancelProvider = () => {
        manager.cancelLogin(login.loginId)
      }
      attempt.device = {
        verificationUrl: this.validateUrl('grok', login.verificationUriComplete ?? login.verificationUri),
        userCode: this.userCode(login.userCode),
      }
      void manager
        .waitForLogin(login.loginId)
        .then(async (result) => {
          if (entry.attempt.state !== 'pending') return
          if (!result.success) return this.finish(entry, 'failed', result.error?.message ?? 'Grok sign-in failed.')
          entry.succeeded = true
          clearTimeout(entry.timer)
          const { account } = await manager.getStatus().catch(() => ({ account: null }))
          await this.complete(entry, { label: 'Grok', email: account?.email ?? null, plan: account?.planType ?? null })
        })
        .catch(() => this.finish(entry, 'failed', 'Grok sign-in failed.'))
    }
  }
  private userCode(code: string | null): string {
    if (!code || code.length > 64)
      throw new InstanceHttpError(502, 'INSTANCE_UNAVAILABLE', 'The provider returned an unexpected sign-in address.')
    return code
  }
  private async complete(entry: Entry, account: NonNullable<FleetLoginAttempt['account']>): Promise<void> {
    if (entry.attempt.state !== 'pending') return
    if (entry.createdSlot && entry.attempt.accountId && account.email)
      this.deps.renameSlot(entry.attempt.accountId, account.label + ' (' + account.email + ')')
    entry.attempt.account = account
    await this.finish(entry, 'completed')
  }
  private finish(
    entry: Entry,
    state: Exclude<FleetLoginAttempt['state'], 'pending'>,
    error: string | null = null
  ): Promise<void> {
    if (entry.attempt.state !== 'pending') return entry.terminal ?? Promise.resolve()
    if (entry.succeeded) {
      state = 'completed'
      error = null
      entry.attempt.account ??= { label: LOGIN_PROVIDER_NAMES[entry.attempt.kind], email: null, plan: null }
    }
    entry.settling = true
    entry.attempt.state = state
    entry.attempt.error = error?.slice(0, 300) ?? null
    clearTimeout(entry.timer)
    entry.terminal = (async () => {
      await entry.ready
      if (state !== 'completed') {
        try {
          await entry.cancelProvider()
        } catch {
          entry.attempt.error ??= 'The provider could not cancel sign-in.'
        }
        if (entry.createdSlot && entry.attempt.accountId) {
          try {
            await this.deps.removeSlot(entry.attempt.accountId)
          } catch {
            entry.attempt.error = 'The sign-in account could not be removed.'
          }
        }
      }
      entry.settling = false
      this.deps.onChanged()
      if (!this.disposed) {
        entry.timer = setTimeout(() => this.entries.delete(entry.attempt.loginId), 10 * 60_000)
        entry.timer.unref()
      }
    })()
    return entry.terminal
  }
  async callback(loginId: string, request: FleetLoginCallbackRequest): Promise<FleetLoginCallbackResponse> {
    const { attempt } = this.entry(loginId)
    if (attempt.state !== 'pending' || !attempt.browser || attempt.browser.callback.path !== request.path)
      throw new InstanceHttpError(409, 'CONFLICT', 'This sign-in does not accept that callback.')
    return this.deps.forward(attempt.browser.callback, request.query)
  }
  async submitCode(loginId: string, code: string): Promise<FleetLoginAttempt> {
    const entry = this.entry(loginId)
    if (entry.attempt.state !== 'pending' || entry.attempt.kind !== 'claude' || !entry.submitCode)
      throw new InstanceHttpError(409, 'CONFLICT', 'This sign-in does not accept a code.')
    try {
      entry.submitCode(code)
    } catch {
      throw new InstanceHttpError(502, 'INSTANCE_UNAVAILABLE', 'The provider could not accept the sign-in code.')
    }
    return this.get(loginId)
  }
  async cancel(loginId: string): Promise<void> {
    await this.finish(this.entry(loginId), 'cancelled')
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.entries.values()].map((entry) => this.finish(entry, 'cancelled')))
    for (const entry of this.entries.values()) clearTimeout(entry.timer)
    this.entries.clear()
  }
}
