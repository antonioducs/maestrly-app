import { accountSchema, type SharedAccount, type AccountGrant, type Bot } from '@maestrly/host-protocol'
import type { HostStore } from '../persistence/store.js'
import { HostError } from '../errors.js'

export type StoredGrant = AccountGrant & { publicKey: string; key: string; fingerprint: string; revoked: boolean }
export type AccountLink = { grantId: string; endpoint: string; certificate: string; expiresAt: string }
export type AccountLease = { id: string; accountId: string; hostId: string; botId: string; name: string; turnId: string; expiresAt: number }
export type AccountOperation = { key: string; fingerprint: string; accountId: string; sourceBotId?: string; phase: 'created' | 'copied' | 'verified' | 'linked'; digest?: string; model?: Bot['model']; originalStatus?: Bot['status'] }
export class AccountRepository {
  constructor(readonly store: HostStore) {}
  list() { return this.store.db.prepare('SELECT body FROM shared_accounts ORDER BY rowid').all().map(row => accountSchema.parse(JSON.parse(String(row.body)))) }
  get(id: string) {
    const row = this.store.db.prepare('SELECT body FROM shared_accounts WHERE id=?').get(id)
    if (!row) throw new HostError('ACCOUNT_NOT_FOUND', 'A conta não está cadastrada neste computador')
    return accountSchema.parse(JSON.parse(String(row.body)))
  }
  save(account: SharedAccount) {
    const clean = accountSchema.parse(account)
    this.store.db.prepare('INSERT INTO shared_accounts(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(clean.id, JSON.stringify(clean))
    return clean
  }
  enabled(id: string) { return this.store.db.prepare('SELECT enabled FROM shared_accounts WHERE id=?').get(id)?.enabled === 1 }
  enable(id: string, enabled: boolean) { this.store.db.prepare('UPDATE shared_accounts SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id) }
  defaultId() { return this.list().find(account => account.isDefault)?.id }
  setDefault(id: string) {
    this.get(id)
    return this.store.transaction(() => {
      for (const account of this.list()) if (account.isDefault !== (account.id === id)) this.save({ ...account, isDefault: account.id === id, revision: account.revision + 1, updatedAt: new Date().toISOString() })
      return this.get(id)
    })
  }
  operation(key: string): AccountOperation | undefined {
    const row = this.store.db.prepare('SELECT * FROM account_operations WHERE key=?').get(key)
    return row ? { ...JSON.parse(String(row.body)), key, fingerprint: String(row.fingerprint), accountId: String(row.account_id), ...(row.source_bot_id ? { sourceBotId: String(row.source_bot_id) } : {}), phase: row.phase as AccountOperation['phase'] } : undefined
  }
  migration(botId: string) {
    const row = this.store.db.prepare('SELECT key FROM account_operations WHERE source_bot_id=?').get(botId)
    return row ? this.operation(String(row.key)) : undefined
  }
  saveOperation(value: AccountOperation) {
    this.store.db.prepare('INSERT INTO account_operations(key,fingerprint,account_id,source_bot_id,phase,body) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET phase=excluded.phase,body=excluded.body').run(value.key, value.fingerprint, value.accountId, value.sourceBotId ?? null, value.phase, JSON.stringify({ digest: value.digest, model: value.model, originalStatus: value.originalStatus }))
  }
  grants(accountId?: string): StoredGrant[] {
    const rows = accountId ? this.store.db.prepare('SELECT body FROM account_grants WHERE account_id=?').all(accountId) : this.store.db.prepare('SELECT body FROM account_grants').all()
    return rows.map(row => JSON.parse(String(row.body)))
  }
  grant(id: string) { return this.grants().find(grant => grant.id === id) }
  saveGrant(value: StoredGrant) {
    this.store.db.prepare('INSERT INTO account_grants(id,account_id,peer_host_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, value.account.id, value.peerHostId, JSON.stringify(value))
  }
  link(id: string): AccountLink | undefined {
    const row = this.store.db.prepare('SELECT body FROM account_links WHERE account_id=?').get(id)
    return row ? JSON.parse(String(row.body)) : undefined
  }
  saveLink(id: string, link: AccountLink) {
    this.store.db.prepare('INSERT INTO account_links(account_id,body) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(link))
  }
  leases(accountId: string, time = Date.now()): AccountLease[] {
    return this.store.db.prepare('SELECT body FROM account_leases WHERE account_id=? AND expires_at>?').all(accountId, time).map(row => JSON.parse(String(row.body)))
  }
  saveLease(value: AccountLease) {
    this.store.db.prepare('DELETE FROM account_leases WHERE expires_at<=?').run(Date.now())
    this.store.db.prepare('INSERT INTO account_leases(id,account_id,peer_host_id,expires_at,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at,body=excluded.body').run(value.id, value.accountId, value.hostId, value.expiresAt, JSON.stringify(value))
  }
  releaseLease(id: string, accountId: string, hostId: string) {
    this.store.db.prepare('DELETE FROM account_leases WHERE id=? AND account_id=? AND peer_host_id=?').run(id, accountId, hostId)
  }
}
