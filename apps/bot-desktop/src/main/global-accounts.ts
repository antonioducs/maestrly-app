import { accountSchema, accountGrantSchema, accountPeerIdentitySchema, type SharedAccount } from '@maestrly/host-protocol'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostTarget, BotCall } from '../shared/types'

type Entry = { targetId: string; account: SharedAccount }
type State = { defaultId?: string; entries: Entry[] }
/** Public account directory for the application. Login and refresh remain in their owning Host. */
export class GlobalAccounts {
  private state: State = { entries: [] }
  private loading?: Promise<void>
  private writes = Promise.resolve()
  private linking = new Map<string, Promise<void>>()
  private discovering = new Map<string, Promise<void>>()
  constructor(private file: string, private options: {
    targets(): Promise<HostTarget[]>
    request(target: HostTarget, method: string, params: Record<string, unknown>): Promise<unknown>
    endpoint(authority: HostTarget, receiver: HostTarget, port: number): Promise<string>
  }) {}
  private load() {
    return this.loading ??= (async () => {
      try {
        const value = JSON.parse(await readFile(this.file, 'utf8')) as State
        this.state = { defaultId: typeof value.defaultId === 'string' ? value.defaultId : undefined, entries: Array.isArray(value.entries) ? value.entries.flatMap(entry => {
          const account = accountSchema.safeParse(entry.account)
          return account.success && typeof entry.targetId === 'string' ? [{ targetId: entry.targetId, account: account.data }] : []
        }) : [] }
      } catch { this.state = { entries: [] } }
    })()
  }
  private save() {
    const value = JSON.stringify(this.state)
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      const file = await open(temporary, 'w', 0o600)
      try { await file.writeFile(value); await file.sync() } finally { await file.close() }
      await rename(temporary, this.file)
    })
    this.writes = write
    return write
  }
  private async remember(target: HostTarget, value: unknown) {
    await this.load()
    const account = accountSchema.parse(value)
    const entry = this.state.entries.find(entry => entry.account.id === account.id)
    if (account.role === 'authority') {
      if (target.hostId && target.hostId !== account.authorityHostId) throw new Error('A conta pertence a outro computador')
      const stored = { ...account, status: { ...account.status, pending: undefined } }
      if (entry) { entry.targetId = target.id; entry.account = stored }
      else this.state.entries.push({ targetId: target.id, account: stored })
      this.state.defaultId ??= account.id
      await this.save()
    }
    return { ...account, isDefault: this.state.defaultId === account.id }
  }
  discover(target: HostTarget) {
    const previous = this.discovering.get(target.id)
    if (previous) return previous
    const pending = (async () => {
      const list = await this.options.request(target, 'account.list', {})
      if (!Array.isArray(list)) throw new Error('Catálogo de contas inválido')
      for (const account of list) await this.remember(target, account)
    })().finally(() => this.discovering.delete(target.id))
    this.discovering.set(target.id, pending)
    return pending
  }
  async list(active: HostTarget) {
    await this.load()
    await this.discover(active)
    return this.state.entries.map(entry => ({ ...entry.account, isDefault: this.state.defaultId === entry.account.id }))
  }
  private async owner(accountId: string) {
    await this.load()
    const entry = this.state.entries.find(entry => entry.account.id === accountId)
    if (!entry) throw new Error('A conta não foi encontrada. Atualize a tela Contas.')
    const target = (await this.options.targets()).find(target => target.id === entry.targetId)
    if (!target || (target.hostId && target.hostId !== entry.account.authorityHostId)) throw new Error('O computador responsável pela conta não está cadastrado')
    return target
  }
  async ensure(accountId: string, receiver: HostTarget, renew = false): Promise<void> {
    const key = `${accountId}:${receiver.id}`
    if (this.linking.has(key)) return this.linking.get(key)!
    const pending = (async () => {
      const owner = await this.owner(accountId)
      if (owner.id === receiver.id || (owner.hostId && owner.hostId === receiver.hostId)) return
      const accounts = await this.options.request(receiver, 'account.list', {}) as SharedAccount[]
      const existing = accounts.map(account => accountSchema.parse(account)).find(account => account.id === accountId)
      if (existing) {
        if (this.state.defaultId === accountId && !existing.isDefault) await this.options.request(receiver, 'account.default', { accountId })
        if (!renew) return // A revoked or expired grant is never silently reissued.
        const current = accountSchema.parse(await this.options.request(receiver, 'account.inspect', { accountId }))
        if (current.available) return
      }
      const peer = accountPeerIdentitySchema.parse(await this.options.request(receiver, 'account.peer.identity', {}))
      if (receiver.hostId && receiver.hostId !== peer.hostId) throw new Error('A identidade do computador mudou')
      const grant = accountGrantSchema.parse(await this.options.request(owner, 'account.peer.grant', {
        accountId, peer, idempotencyKey: randomUUID(), expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
      }))
      if (!grant.authority.port || grant.authority.hostId !== (owner.hostId ?? grant.account.authorityHostId)) throw new Error('O serviço de contas não está disponível neste computador')
      await this.options.request(receiver, 'account.peer.link', { grant, endpoint: await this.options.endpoint(owner, receiver, grant.authority.port) })
      if (this.state.defaultId === accountId) await this.options.request(receiver, 'account.default', { accountId })
    })().finally(() => this.linking.delete(key))
    this.linking.set(key, pending)
    return pending
  }
  async sync(active: HostTarget, renew = false) {
    await this.load()
    await this.discover(active)
    const targets = await this.options.targets()
    const trusted = targets.filter(target => target.id === active.id || target.hostId)
    const failures: string[] = []
    // Discover accounts created before this application profile first saw each trusted Host.
    await Promise.allSettled(trusted.filter(target => target.id !== active.id).map(target => this.discover(target)))
    for (const account of this.state.entries) if (account.account.status.state === 'connected') {
      const results = await Promise.allSettled(trusted.map(target => this.ensure(account.account.id, target, renew && target.id === active.id)))
      results.forEach((result, index) => { if (result.status === 'rejected') failures.push(trusted[index].displayName) })
    }
    return { unavailableHosts: [...new Set(failures)] }
  }
  async call(call: BotCall, active: HostTarget) {
    if (call.method.startsWith('account.peer.')) throw new Error('O vínculo entre Hosts é gerenciado pelo aplicativo')
    if (call.method === 'account.list') return this.list(active)
    const accountId = typeof call.params.accountId === 'string' ? call.params.accountId : undefined
    const target = accountId ? await this.owner(accountId) : active
    let result: unknown
    try { result = await this.options.request(target, call.method, call.params) }
    catch (error) {
      if (call.method === 'account.inspect' && accountId) {
        const entry = this.state.entries.find(entry => entry.account.id === accountId)
        if (entry) return { ...entry.account, isDefault: this.state.defaultId === accountId, available: false, issue: 'O computador responsável pela conta está indisponível.' }
      }
      throw error
    }
    if (call.method === 'account.default' && accountId) { this.state.defaultId = accountId; await this.save() }
    if (!['account.models', 'account.impact'].includes(call.method)) {
      result = await this.remember(target, result)
      const account = result as SharedAccount
      if (account.status.state === 'connected' && ['account.inspect', 'account.setApiKey', 'account.migrate', 'account.default'].includes(call.method)) {
        void this.ensure(account.id, active).catch(() => {})
      }
    }
    return result
  }
}
