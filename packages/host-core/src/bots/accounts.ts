import type { AccountAuthority } from '../accounts/authority.js'
import type { AccountDelegation } from '../accounts/delegation.js'
import { authStatusSchema, modelCatalogEntrySchema, type AuthStatus, type Bot, type ModelCatalogEntry } from '@maestrly/host-protocol'
import { randomUUID } from 'node:crypto'
import { HostError } from '../errors.js'
import type { GuestSession } from '../guest/session.js'
import { type BotRepository, now } from './repository.js'
import type { BotEvents } from './events.js'

/**
 * Provider account lives in the guest's private CODEX_HOME. The Host only relays the
 * official device flow or a one-shot API key; nothing secret is persisted here.
 */
export class BotAccounts {
  constructor(
    private readonly repo: BotRepository,
    private readonly session: (bot: Bot) => Promise<GuestSession>,
    private readonly events: BotEvents,
    private readonly onConnected?: (bot: Bot) => void,
    private readonly shared?: { authority: AccountAuthority; delegation: AccountDelegation }
  ) {}
  private applyState(bot: Bot, status: AuthStatus) {
    const latest = this.repo.bot(bot.id)
    if (latest.accountState !== status.state) {
      this.repo.transaction(() => this.repo.saveBot({ ...latest, accountState: status.state, revision: latest.revision + 1, updatedAt: now() }))
      this.events.record(bot.id, 'account.changed', status.state === 'connected' ? 'Conta de IA conectada' : `Conta: ${status.state}`)
    }
    return this.repo.bot(bot.id)
  }
  async status(botId: string): Promise<AuthStatus> {
    const bot = this.repo.bot(botId)
    if (bot.accountId && this.shared) {
      const account = await this.shared.authority.inspect(bot.accountId)
      this.applyState(bot, account.status)
      if (account.status.state === 'connected' && account.available) {
        await this.shared.delegation.authenticate(botId, await this.session(bot))
        await this.ensureModel(this.repo.bot(botId))
      }
      return account.status
    }
    let session: GuestSession
    try {
      session = await this.session(bot)
    } catch {
      return { state: bot.accountState === 'connected' ? 'connected' : bot.accountState, provider: 'codex' }
    }
    const status = authStatusSchema.parse(await session.request('auth.status', {}))
    const latest = this.applyState(bot, status)
    if (status.state === 'connected') await this.ensureModel(latest)
    return status
  }
  async start(botId: string): Promise<AuthStatus> {
    const bot = this.repo.bot(botId)
    if (bot.accountId) throw new HostError('ACCOUNT_MANAGED', 'Gerencie esta conexão na tela Contas; ela é compartilhada entre os bots')
    const session = await this.session(bot)
    const status = authStatusSchema.parse(await session.request('auth.start', { method: 'device' }, 60_000))
    if (status.pending && !/^https:\/\/(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com)\//.test(status.pending.verificationUrl))
      throw new HostError('AUTH_URL_UNTRUSTED', 'O provedor devolveu um endereço de login inesperado; o login foi bloqueado')
    this.applyState(bot, status)
    return status
  }
  async cancel(botId: string): Promise<AuthStatus> {
    const bot = this.repo.bot(botId)
    if (bot.accountId) throw new HostError('ACCOUNT_MANAGED', 'Gerencie esta conexão na tela Contas; ela é compartilhada entre os bots')
    const session = await this.session(bot)
    const current = authStatusSchema.parse(await session.request('auth.status', {}))
    if (current.pending) await session.request('auth.cancel', { loginId: current.pending.loginId })
    const status = authStatusSchema.parse(await session.request('auth.status', {}))
    this.applyState(bot, status)
    return status
  }
  async logout(botId: string): Promise<AuthStatus> {
    const bot = this.repo.bot(botId)
    if (bot.accountId) throw new HostError('ACCOUNT_MANAGED', 'Gerencie esta conexão na tela Contas; ela é compartilhada entre os bots')
    if (this.repo.activeTurn(botId)) throw new HostError('BOT_BUSY', 'Pare a tarefa atual antes de desconectar a conta')
    const session = await this.session(bot)
    await session.request('auth.logout', {})
    const status = authStatusSchema.parse(await session.request('auth.status', {}))
    this.applyState(bot, status)
    return status
  }
  /** The key travels once to the guest secret channel; the Host never journals it. */
  async setApiKey(botId: string, apiKey: string): Promise<AuthStatus> {
    const bot = this.repo.bot(botId)
    if (bot.accountId) throw new HostError('ACCOUNT_MANAGED', 'Gerencie esta conexão na tela Contas; ela é compartilhada entre os bots')
    const session = await this.session(bot)
    const secretRef = randomUUID()
    await session.request('auth.secret', { secretRef, apiKey })
    const status = authStatusSchema.parse(await session.request('auth.start', { method: 'apiKey', secretRef }, 60_000))
    const latest = this.applyState(bot, status)
    if (status.state === 'connected') await this.ensureModel(latest)
    return status
  }
  async models(botId: string): Promise<ModelCatalogEntry[]> {
    const bot = this.repo.bot(botId)
    if (bot.accountId && this.shared) return this.shared.authority.models(bot.accountId)
    const session = await this.session(bot)
    const result = await session.request('models.list', {}, 60_000)
    if (!Array.isArray(result) || result.length > 100) throw new HostError('RUNTIME_PROTOCOL', 'Invalid model catalogue')
    return result.map((entry) => modelCatalogEntrySchema.parse(entry))
  }
  /** Recommended = provider default when offered, else deterministic first entry by id. Persisted once. */
  async ensureModel(bot: Bot) {
    if (bot.model) {
      this.onConnected?.(bot)
      return bot.model
    }
    const catalogue = await this.models(bot.id)
    const selected = resolveRecommendedModel(catalogue)
    if (!selected) throw new HostError('MODEL_UNAVAILABLE', 'A conta conectada não oferece nenhum modelo compatível')
    const latest = this.repo.bot(bot.id)
    this.repo.transaction(() => this.repo.saveBot({ ...latest, model: selected, revision: latest.revision + 1, updatedAt: now() }))
    this.events.record(bot.id, 'account.changed', `Modelo recomendado: ${selected.model}`, { detail: selected })
    this.onConnected?.(this.repo.bot(bot.id))
    return selected
  }
}
export function resolveRecommendedModel(catalogue: ModelCatalogEntry[]): Bot['model'] | undefined {
  const entry = catalogue.find((m) => m.recommended) ?? [...catalogue].sort((a, b) => a.id.localeCompare(b.id))[0]
  if (!entry) return undefined
  const effort = entry.defaultEffort ?? (entry.efforts.includes('medium') ? 'medium' : entry.efforts[0])
  return { model: entry.id, ...(effort ? { effort } : {}), source: 'recommended' }
}
