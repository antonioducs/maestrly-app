import { createHash, randomUUID } from 'node:crypto'
import { authStatusSchema, delegatedCredentialSchema, modelCatalogEntrySchema, botSchema,
  type AuthStatus, type Bot, type SharedAccount, type DelegatedCredential, type ModelCatalogEntry, type LegacyCredential } from '@maestrly/host-protocol'
import type { HostStore } from '../persistence/store.js'
import { HostError } from '../errors.js'
import { fingerprint } from '../bots/interactions.js'
import { AccountRepository } from './repository.js'
import type { AccountProvider, AccountProviderFactory } from './provider.js'
import { privateDirectory } from './private-files.js'

export interface RemoteAccounts { call(accountId: string, method: 'inspect' | 'models' | 'credential' | 'lease' | 'release', params: Record<string, unknown>): Promise<unknown> }
export type LeaseInput = { botId: string; name: string; turnId: string }
const now = () => new Date().toISOString()
const disconnected: AuthStatus = { state: 'disconnected', provider: 'codex' }
export class AccountAuthority {
  readonly repo: AccountRepository
  private providers = new Map<string, Promise<AccountProvider>>()
  private queues = new Map<string, Promise<unknown>>()
  private credentials = new Map<string, { forced: boolean; credentialHash?: string; promise: Promise<DelegatedCredential> }>()
  private refreshedAt = new Map<string, number>()
  private remote?: RemoteAccounts
  private closed = false
  private timer?: NodeJS.Timeout
  constructor(private options: { store: HostStore; directory: string; provider?: AccountProviderFactory; onChanged?: (account: SharedAccount) => void }) {
    this.repo = new AccountRepository(options.store)
  }
  async ready() {
    await privateDirectory(this.options.directory)
    this.timer = setInterval(() => { void this.poll().catch(() => {}) }, 5000)
    this.timer.unref()
  }
  setRemote(remote: RemoteAccounts) { this.remote = remote }
  list() { return this.repo.list() }
  create(params: { idempotencyKey: string; name: string }, sourceBotId?: string): SharedAccount {
    if (!this.options.provider) throw new HostError('ACCOUNT_SERVICE_UNAVAILABLE', 'Atualize o Host com o serviço de contas para conectar uma conta geral')
    const print = fingerprint({ method: sourceBotId ? 'account.migrate' : 'account.create', ...params, sourceBotId })
    return this.options.store.transaction(() => {
      const prior = this.repo.operation(params.idempotencyKey)
      if (prior) {
        if (prior.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada para outra conta')
        return this.repo.get(prior.accountId)
      }
      if (this.repo.list().length >= 100) throw new HostError('ACCOUNT_LIMIT', 'O limite de contas foi atingido')
      const account = this.repo.save({ id: randomUUID(), name: params.name, provider: 'codex', authorityHostId: this.options.store.hostId,
        role: 'authority', status: disconnected, available: true, isDefault: !this.repo.defaultId(), revision: 0, createdAt: now(), updatedAt: now() })
      this.repo.saveOperation({ key: params.idempotencyKey, fingerprint: print, accountId: account.id, sourceBotId, phase: 'created' })
      return account
    })
  }
  setDefault(id: string) { return this.repo.setDefault(id) }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.closed) throw new HostError('ACCOUNT_UNAVAILABLE', 'O serviço de contas está encerrando')
      try { return await work() } catch (error) {
        // Provider errors may contain credential values; only our own public errors cross this boundary.
        if (error instanceof HostError) throw error
        throw new HostError('ACCOUNT_UNAVAILABLE', 'Não foi possível acessar a conta. Tente novamente em Contas.')
      }
    })
    this.queues.set(id, pending)
    void pending.finally(() => { if (this.queues.get(id) === pending) this.queues.delete(id) }).catch(() => {})
    return pending
  }
  private async provider(id: string) {
    if (this.repo.get(id).role !== 'authority') throw new HostError('ACCOUNT_AUTHORITY_REQUIRED', 'Gerencie o login no computador responsável pela conta')
    if (!this.options.provider) throw new HostError('ACCOUNT_SERVICE_UNAVAILABLE', 'O serviço de contas não está instalado')
    let pending = this.providers.get(id)
    if (pending) {
      const current = await pending
      if (current.healthy?.() === false) { await current.close().catch(() => {}); this.providers.delete(id); pending = undefined }
    }
    if (!pending) {
      pending = this.options.provider(id)
      this.providers.set(id, pending)
      void pending.catch(() => { if (this.providers.get(id) === pending) this.providers.delete(id) })
    }
    return pending
  }
  private update(id: string, status: AuthStatus, available = true, issue?: string) {
    const clean = authStatusSchema.parse(status)
    const account = this.repo.get(id)
    if (JSON.stringify(account.status) === JSON.stringify(clean) && account.available === available && account.issue === issue) return account
    const value = this.repo.save({ ...account, status: clean, available, issue, revision: account.revision + 1, updatedAt: now() })
    this.options.onChanged?.(value)
    return value
  }
  private async status(id: string) {
    if (!this.repo.enabled(id)) return this.update(id, disconnected)
    const account = this.repo.get(id)
    if (account.role === 'linked') {
      if (!this.remote) throw new HostError('ACCOUNT_UNAVAILABLE', 'O vínculo com o serviço de contas não está disponível')
      const value = await this.remote.call(id, 'inspect', {}) as SharedAccount
      return this.update(id, value.status, value.available, value.issue)
    }
    return this.update(id, await (await this.provider(id)).status())
  }
  inspect(id: string) {
    return this.serial(id, async () => {
      try { return await this.status(id) }
      catch { const account = this.repo.get(id); return this.update(id, account.status, false, 'O serviço responsável pela conta está indisponível. Verifique a conexão e tente novamente.') }
    })
  }
  start(id: string) {
    return this.serial(id, async () => {
      this.assertIdle(id)
      const provider = await this.provider(id)
      if (!this.repo.enabled(id)) await provider.logout()
      const status = await provider.startDevice()
      this.repo.enable(id, true)
      return this.update(id, status)
    })
  }
  cancel(id: string) { return this.serial(id, async () => this.update(id, await (await this.provider(id)).cancel())) }
  setApiKey(id: string, key: string) {
    return this.serial(id, async () => {
      this.assertIdle(id)
      const status = await (await this.provider(id)).startApiKey(key)
      this.repo.enable(id, true)
      this.refreshedAt.delete(id)
      return this.update(id, status)
    })
  }
  logout(id: string) {
    return this.serial(id, async () => {
      this.assertIdle(id)
      const provider = await this.provider(id)
      // Durable revocation precedes clearing the provider file. A failed cleanup cannot resurrect the login.
      this.repo.enable(id, false)
      this.refreshedAt.delete(id)
      const value = this.update(id, disconnected)
      try { await provider.logout() } catch { return this.update(id, disconnected, false, 'A conta foi desconectada. A limpeza local precisa ser concluída antes de conectar novamente.') }
      return value
    })
  }
  async models(id: string): Promise<ModelCatalogEntry[]> {
    return this.serial(id, async () => {
      const account = await this.status(id)
      this.assertConnected(account)
      const value = account.role === 'linked' ? await this.remote!.call(id, 'models', {}) : await (await this.provider(id)).models()
      if (!Array.isArray(value) || value.length > 100) throw new HostError('ACCOUNT_PROTOCOL', 'O catálogo de modelos recebido é inválido')
      return value.map(model => modelCatalogEntrySchema.parse(model))
    })
  }
  async validateModel(id: string, selection?: Bot['model']): Promise<NonNullable<Bot['model']>> {
    const catalogue = await this.models(id)
    const model = selection ? catalogue.find(entry => entry.id === selection.model) : catalogue.find(entry => entry.recommended) ?? catalogue[0]
    if (!model || (selection?.effort && !model.efforts.includes(selection.effort)))
      throw new HostError('MODEL_UNAVAILABLE', 'Escolha um modelo e um effort disponíveis para esta conta')
    const effort = selection?.effort ?? model.defaultEffort ?? model.efforts[0]
    return { model: model.id, ...(effort ? { effort } : {}), source: selection ? selection.source : 'recommended' }
  }
  assertBindable(id: string) { this.assertConnected(this.repo.get(id)) }
  private assertConnected(account: SharedAccount) {
    if (!this.repo.enabled(account.id) || account.status.state !== 'connected') throw new HostError('ACCOUNT_REQUIRED', 'Conecte a conta geral em Contas antes de continuar')
    if (!account.available) throw new HostError('ACCOUNT_UNAVAILABLE', 'O serviço responsável pela conta está indisponível')
  }
  credential(id: string, forceRefresh: boolean, credentialHash?: string): Promise<DelegatedCredential> {
    const existing = this.credentials.get(id)
    if (existing) {
      if (!forceRefresh || (existing.forced && existing.credentialHash === credentialHash)) return existing.promise
      return existing.promise.then(() => this.credential(id, true, credentialHash))
    }
    const promise = this.serial(id, async () => {
      const account = await this.status(id)
      this.assertConnected(account)
      const force = forceRefresh && Date.now() - (this.refreshedAt.get(id) ?? 0) > 2000
      let value: unknown
      let refreshed = force
      if (account.role === 'linked') value = await this.remote!.call(id, 'credential', { forceRefresh: force, ...(credentialHash ? { credentialHash } : {}) })
      else {
        const provider = await this.provider(id)
        if (force && credentialHash) {
          const current = await provider.credential(false)
          const currentHash = createHash('sha256').update(current.type === 'apiKey' ? current.apiKey : current.accessToken).digest('hex')
          // Another session may already have refreshed the exact token that failed in this worker.
          refreshed = currentHash === credentialHash
          value = refreshed ? await provider.credential(true) : current
        } else value = await provider.credential(force)
      }
      const credential = delegatedCredentialSchema.parse(value)
      if (refreshed) this.refreshedAt.set(id, Date.now())
      return credential
    })
    this.credentials.set(id, { promise, forced: forceRefresh, credentialHash })
    void promise.finally(() => { if (this.credentials.get(id)?.promise === promise) this.credentials.delete(id) }).catch(() => {})
    return promise
  }
  private bots(id: string) {
    return this.options.store.db.prepare("SELECT body FROM bots WHERE status != 'archived'").all().map(row => botSchema.parse(JSON.parse(String(row.body)))).filter(bot => bot.accountId === id)
  }
  impact(id: string) {
    this.repo.get(id)
    const bots = this.bots(id).map(bot => ({ botId: bot.id, name: bot.name, hostId: this.options.store.hostId, active: !!this.options.store.db.prepare("SELECT id FROM bot_turns WHERE bot_id=? AND status IN ('queued','starting','running','waiting_approval','waiting_input','cancelling','needs_attention')").get(bot.id) }))
    const leases = this.repo.leases(id)
    for (const lease of leases) if (!bots.some(bot => bot.hostId === lease.hostId && bot.botId === lease.botId)) bots.push({ botId: lease.botId, name: lease.name, hostId: lease.hostId, active: true })
    return { bots, activeLeases: leases.length }
  }
  assertIdle(id: string) {
    const impact = this.impact(id)
    if (impact.activeLeases || impact.bots.some(bot => bot.active)) throw new HostError('ACCOUNT_BUSY', 'Pare as tarefas de todos os bots que usam esta conta antes de desconectá-la ou trocar o login')
  }
  async renewLease(id: string, input: LeaseInput, hostId = this.options.store.hostId) {
    return this.serial(id, async () => {
      const account = await this.status(id)
      this.assertConnected(account)
      if (account.role === 'linked') {
        await this.remote!.call(id, 'lease', input)
        return
      }
      if (this.repo.leases(id).length >= 1000 && !this.repo.leases(id).some(lease => lease.id === leaseId(id, hostId, input.turnId)))
        throw new HostError('ACCOUNT_BUSY', 'O limite de tarefas desta conta foi atingido')
      this.repo.saveLease({ id: leaseId(id, hostId, input.turnId), accountId: id, hostId, ...input, expiresAt: Date.now() + 45000 })
    })
  }
  async releaseLease(id: string, turnId: string, hostId = this.options.store.hostId) {
    if (this.repo.get(id).role === 'linked') { await this.remote?.call(id, 'release', { turnId }); return }
    this.repo.releaseLease(leaseId(id, hostId, turnId), id, hostId)
  }
  async importCredential(id: string, credential: LegacyCredential) {
    return this.serial(id, async () => {
      const provider = await this.provider(id)
      if (!provider.importCredential) throw new HostError('ACCOUNT_MIGRATION_UNAVAILABLE', 'O serviço não suporta migração de conta')
      await provider.importCredential(credential)
      return this.update(id, await provider.status())
    })
  }
  private async poll() {
    if (this.closed) return
    await Promise.allSettled(this.repo.list().filter(account => this.providers.has(account.id) && this.repo.enabled(account.id)).map(async account => {
      if (account.status.state === 'connecting') await this.inspect(account.id)
      else if (this.repo.leases(account.id).length) await this.credential(account.id, false)
    }))
  }
  async close() {
    this.closed = true
    clearInterval(this.timer)
    await Promise.allSettled([...this.providers.values()].map(async promise => (await promise).close()))
    this.providers.clear()
  }
}
function leaseId(accountId: string, hostId: string, turnId: string) { return createHash('sha256').update(JSON.stringify([accountId, hostId, turnId])).digest('hex') }
