import { createHash } from 'node:crypto'
import { legacyCredentialSchema, type SharedAccount } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { type BotRepository, now } from '../bots/repository.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { AccountAuthority } from './authority.js'
import type { AccountDelegation } from './delegation.js'

/** The old login remains in its session until the independent authority has verified it. */
export class AccountMigration {
  private pending = new Map<string, Promise<SharedAccount>>()
  constructor(private accounts: AccountAuthority, private bots: BotRepository, private coordinator: RuntimeCoordinator, private delegation: AccountDelegation) {}
  migrate(botId: string, key: string) {
    const byKey = this.accounts.repo.operation(key)
    if (byKey && byKey.sourceBotId !== botId) return Promise.reject(new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada em outra operação de conta'))
    const existing = this.pending.get(botId)
    if (existing) return existing
    const pending = this.run(botId, key)
    this.pending.set(botId, pending)
    void pending.finally(() => { if (this.pending.get(botId) === pending) this.pending.delete(botId) }).catch(() => {})
    return pending
  }
  private async run(botId: string, key: string) {
    const original = this.bots.bot(botId)
    let operation = this.accounts.repo.operation(key) ?? this.accounts.repo.migration(botId)
    if (original.accountId && (!operation || operation.phase === 'linked')) return this.accounts.repo.get(original.accountId)
    if (original.status === 'archived' || !original.vmId || this.bots.activeTurn(botId)) throw new HostError('ACCOUNT_BUSY', 'Pare a tarefa do bot antes de compartilhar sua conta')
    const session = await this.coordinator.session(original)
    if (!session.capabilities.includes('account.delegation.v1')) throw new HostError('ACCOUNT_MIGRATION_UNAVAILABLE', 'Atualize o ambiente antes de compartilhar a conta existente')
    const account = operation ? this.accounts.repo.get(operation.accountId) : this.accounts.create({ idempotencyKey: key, name: `Conta de ${original.name}`.slice(0, 80) }, botId)
    operation = this.accounts.repo.migration(botId)!
    operation = { ...operation, originalStatus: operation.originalStatus ?? original.status }
    this.accounts.repo.saveOperation(operation)
    this.bots.transaction(() => {
      if (this.bots.activeTurn(botId)) throw new HostError('ACCOUNT_BUSY', 'Pare a tarefa do bot antes de compartilhar sua conta')
      const bot = this.bots.bot(botId)
      this.bots.saveBot({ ...bot, runtimeState: 'preparing', revision: bot.revision + 1, updatedAt: now() })
    })
    const leaseId = 'migration-' + createHash('sha256').update(operation.key).digest('hex')
    let leaseTimer: NodeJS.Timeout | undefined
    let committed = operation.phase === 'linked' || !!original.accountId
    try {
      if (operation.phase === 'created') {
        const exported = await session.request('auth.exportLegacy', {}) as { credential?: unknown; digest?: string }
        const credential = legacyCredentialSchema.parse(exported?.credential)
        const digest = createHash('sha256').update(JSON.stringify(credential)).digest('hex')
        if (exported.digest !== digest) throw new HostError('ACCOUNT_MIGRATION_INVALID', 'O ambiente não confirmou a credencial exportada')
        await this.accounts.importCredential(account.id, credential)
        operation = { ...operation, phase: 'copied', digest }
        this.accounts.repo.saveOperation(operation)
      }
      await this.accounts.credential(account.id, false)
      const renew = () => this.accounts.renewLease(account.id, { botId, name: original.name, turnId: leaseId })
      await renew()
      leaseTimer = setInterval(() => { void renew().catch(() => {}) }, 10000)
      leaseTimer.unref()
      const model = await this.accounts.validateModel(account.id, operation.model ?? original.model)
      operation = { ...operation, phase: 'verified', model }
      this.accounts.repo.saveOperation(operation)
      this.accounts.assertBindable(account.id)
      // This private command is idempotent by the digest and restarts only the provider process.
      committed = true // A lost reply may mean the guest already completed the cutover.
      const result = await session.request('auth.commitMigration', { digest: operation.digest! }, 15000) as { committed?: boolean }
      if (result?.committed !== true) throw new HostError('ACCOUNT_MIGRATION_UNCERTAIN', 'Verifique a conclusão da migração da conta')
      committed = true
      this.bots.transaction(() => {
        const bot = this.bots.bot(botId)
        this.bots.saveBot({ ...bot, accountId: account.id, accountState: 'connected', model, revision: bot.revision + 1, updatedAt: now() })
      })
      let ready = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const runtime = await session.request('runtime.inspect', {}, 2000) as { state?: string }
          if (runtime.state === 'ready') { await this.delegation.authenticate(botId, session); ready = true; break }
        } catch { /* Provider supervision is reopening with the ephemeral credential store. */ }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!ready) throw new HostError('ACCOUNT_MIGRATION_UNCERTAIN', 'A conta foi preservada no Host, mas a conexão do bot precisa ser retomada')
      this.bots.transaction(() => {
        const bot = this.bots.bot(botId)
        this.bots.saveBot({ ...bot, runtimeState: 'ready', status: operation!.originalStatus!, revision: bot.revision + 1, updatedAt: now() })
        this.accounts.repo.saveOperation({ ...operation!, phase: 'linked' })
      })
      this.coordinator.events.record(botId, 'account.changed', 'O bot passou a usar a conta geral; histórico e arquivos preservados')
      return this.accounts.repo.get(account.id)
    } catch (error) {
      const bot = this.bots.bot(botId)
      this.bots.saveBot({ ...bot, runtimeState: committed ? 'unreachable' : original.runtimeState, status: committed ? 'needs_attention' : original.status, revision: bot.revision + 1, updatedAt: now() })
      if (error instanceof HostError) throw error
      throw new HostError('ACCOUNT_MIGRATION_UNAVAILABLE', committed ? 'A conta está preservada no Host. Retome a migração em Contas para reconectar o bot.' : 'Não foi possível concluir a migração. A conta anterior foi preservada; tente novamente em Contas.')
    } finally {
      clearInterval(leaseTimer)
      await this.accounts.releaseLease(account.id, leaseId).catch(() => {})
    }
  }
}
