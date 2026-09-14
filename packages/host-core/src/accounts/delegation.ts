import { authStatusSchema, type Bot, type DelegatedCredential, type SharedAccount } from '@maestrly/host-protocol'
import type { GuestSession } from '../guest/session.js'
import { HostError } from '../errors.js'
import { type BotRepository, now } from '../bots/repository.js'
import type { AccountAuthority } from './authority.js'

/** The Host resolves account identity from the bot binding; workers never choose it. */
export class AccountDelegation {
  constructor(private repo: BotRepository, private accounts: AccountAuthority) {}
  private bound(botId: string) {
    const bot = this.repo.bot(botId)
    if (bot.status === 'archived' || !bot.accountId) throw new HostError('ACCOUNT_REQUIRED', 'Este bot não tem uma conta geral vinculada')
    return bot as Bot & { accountId: string }
  }
  async credential(botId: string, forceRefresh: boolean, credentialHash?: string): Promise<DelegatedCredential> {
    const id = this.bound(botId).accountId
    const credential = await this.accounts.credential(id, forceRefresh, credentialHash)
    if (this.bound(botId).accountId !== id) throw new HostError('ACCOUNT_REVOKED', 'A conta do bot mudou durante a renovação')
    this.accounts.assertBindable(id)
    return credential
  }
  async prepareEmpty(botId: string, session: GuestSession) {
    const bot = this.repo.bot(botId)
    if (bot.accountState === 'connected' || this.repo.activeTurn(botId)) throw new HostError('ACCOUNT_MIGRATION_REQUIRED', 'Compartilhe a conta existente em Contas antes de alterar este vínculo')
    if (!session.capabilities.includes('account.delegation.v1')) throw new HostError('ACCOUNT_DELEGATION_UNAVAILABLE', 'Atualize o ambiente para usar a conta geral')
    const result = await session.request('auth.prepareDelegation', {}) as { prepared?: boolean }
    if (result.prepared !== true) throw new HostError('ACCOUNT_UNAVAILABLE', 'O ambiente não confirmou a preparação da conta')
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await session.request('runtime.inspect', {}, 2000) as { state?: string }).state === 'ready') return } catch {}
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new HostError('ACCOUNT_UNAVAILABLE', 'A conexão do bot precisa ser retomada')
  }
  async authenticate(botId: string, session: GuestSession) {
    const bot = this.bound(botId)
    if (!session.capabilities.includes('account.delegation.v1')) throw new HostError('ACCOUNT_DELEGATION_UNAVAILABLE', 'Atualize o ambiente para usar a conta geral')
    const credential = await this.accounts.credential(bot.accountId, false)
    const current = this.bound(botId)
    if (current.accountId !== bot.accountId) throw new HostError('ACCOUNT_REQUIRED', 'A conta do bot mudou durante a conexão')
    const status = authStatusSchema.parse(await session.request('auth.delegate', { credential }))
    if (status.state !== 'connected') throw new HostError('ACCOUNT_UNAVAILABLE', 'O ambiente não confirmou o acesso à conta geral')
    const latest = this.repo.bot(botId)
    if (latest.accountState !== 'connected') this.repo.saveBot({ ...latest, accountState: 'connected', revision: latest.revision + 1, updatedAt: now() })
    return status
  }
  async prepare(bot: Bot, session: GuestSession, turnId: string) {
    if (!bot.accountId) return
    await this.accounts.renewLease(bot.accountId, { botId: bot.id, name: bot.name, turnId })
    try { await this.authenticate(bot.id, session) }
    catch (error) { await this.accounts.releaseLease(bot.accountId, turnId).catch(() => {}); throw error }
  }
  async renew(bot: Bot, turnId: string) {
    if (bot.accountId && this.repo.activeTurn(bot.id)?.id === turnId) {
      await this.accounts.renewLease(bot.accountId, { botId: bot.id, name: bot.name, turnId })
      if (this.repo.activeTurn(bot.id)?.id !== turnId) await this.accounts.releaseLease(bot.accountId, turnId)
    }
  }
  async release(bot: Bot, turnId: string) {
    if (bot.accountId) await this.accounts.releaseLease(bot.accountId, turnId)
  }
  changed(account: SharedAccount) {
    this.repo.transaction(() => {
      for (const bot of this.repo.bots(true)) if (bot.accountId === account.id && bot.accountState !== account.status.state)
        this.repo.saveBot({ ...bot, accountState: account.status.state, revision: bot.revision + 1, updatedAt: now() })
    })
  }
}
