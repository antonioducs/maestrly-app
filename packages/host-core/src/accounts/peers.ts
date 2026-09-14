import { createPublicKey, randomUUID, X509Certificate } from 'node:crypto'
import { accountGrantSchema, accountSchema, type AccountGrant, type AccountPeerIdentity } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import { fingerprint } from '../bots/interactions.js'
import type { AccountAuthority, RemoteAccounts } from './authority.js'
import { peerKeys, type PeerKeys } from './peer-identity.js'
import { AccountPeerServer, accountEndpoint, callAccountPeer, type PeerRequest } from './peer-transport.js'
import type { StoredGrant } from './repository.js'

export class AccountPeers implements RemoteAccounts {
  private keys!: PeerKeys
  private server?: AccountPeerServer
  constructor(private authority: AccountAuthority, private directory: string, private bind?: { host: string; port: number }) {}
  async ready() {
    this.keys = await peerKeys(this.directory, this.authority.repo.store.hostId)
    this.authority.setRemote(this)
  }
  async identity(serve = false): Promise<AccountPeerIdentity> {
    const hostId = this.authority.repo.store.hostId
    if (!this.bind) return { hostId, publicKey: this.keys.publicKey }
    if (!serve) return { hostId, publicKey: this.keys.publicKey, certificate: this.keys.certificate, ...(this.bind.port ? { port: this.bind.port } : {}) }
    this.server ??= new AccountPeerServer(hostId, this.keys, id => this.authority.repo.grant(id), (packet, grant) => this.handle(packet, grant))
    const port = await this.server.listen(this.bind.host, this.bind.port)
    return { hostId, publicKey: this.keys.publicKey, certificate: this.keys.certificate, port }
  }
  async grant(input: { accountId: string; peer: AccountPeerIdentity; idempotencyKey: string; expiresAt: string }): Promise<AccountGrant> {
    const account = this.authority.repo.get(input.accountId)
    if (account.role !== 'authority' || input.peer.hostId === account.authorityHostId) throw new HostError('ACCOUNT_LINK_INVALID', 'Escolha outro computador para compartilhar esta conta')
    const key = createPublicKey(input.peer.publicKey)
    if (key.asymmetricKeyType !== 'ed25519') throw new HostError('ACCOUNT_LINK_INVALID', 'A identidade do computador não é compatível')
    const print = fingerprint(input)
    const previous = this.authority.repo.grants().find(grant => grant.key === input.idempotencyKey)
    if (previous) {
      if (previous.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'A chave já foi usada em outro vínculo')
      if (previous.revoked) throw new HostError('ACCOUNT_REVOKED', 'Este vínculo foi revogado')
      return accountGrantSchema.parse(publicGrant(previous))
    }
    const expires = Date.parse(input.expiresAt)
    if (!Number.isFinite(expires) || expires < Date.now() + 60000 || expires > Date.now() + 366 * 86400000) throw new HostError('ACCOUNT_LINK_INVALID', 'A validade do vínculo deve estar entre um minuto e um ano')
    const authority = await this.identity(true)
    if (!authority.port || !authority.certificate) throw new HostError('ACCOUNT_LINK_UNAVAILABLE', 'O serviço de contas deste Host não está configurado para compartilhar com outros computadores')
    const value: StoredGrant = { id: randomUUID(), account, authority, peerHostId: input.peer.hostId, expiresAt: input.expiresAt,
      publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), key: input.idempotencyKey, fingerprint: print, revoked: false }
    this.authority.repo.saveGrant(value)
    return accountGrantSchema.parse(publicGrant(value))
  }
  async link(input: { grant: AccountGrant; endpoint: string }) {
    const grant = accountGrantSchema.parse(input.grant)
    const repo = this.authority.repo
    if (grant.peerHostId !== repo.store.hostId || grant.authority.hostId !== grant.account.authorityHostId || grant.account.role !== 'authority' || !grant.authority.certificate || !grant.authority.port)
      throw new HostError('ACCOUNT_LINK_INVALID', 'O vínculo não corresponde a estes computadores')
    const endpoint = accountEndpoint(input.endpoint)
    if (Number(endpoint.port) !== grant.authority.port) throw new HostError('ACCOUNT_LINK_INVALID', 'A porta não corresponde ao serviço autorizado')
    new X509Certificate(grant.authority.certificate)
    const existing = repo.list().find(account => account.id === grant.account.id)
    if (existing && (existing.role !== 'linked' || existing.authorityHostId !== grant.authority.hostId)) throw new HostError('ACCOUNT_LINK_INVALID', 'A conta já tem outra autoridade')
    const link = { grantId: grant.id, endpoint: endpoint.origin + '/', certificate: grant.authority.certificate, expiresAt: grant.expiresAt }
    // Prove connectivity and both identities before persisting an available account.
    const verified = accountSchema.parse(await callAccountPeer(link, { hostId: repo.store.hostId, privateKey: this.keys.privateKey }, grant.authority.hostId, 'inspect', {}))
    if (verified.id !== grant.account.id || verified.authorityHostId !== grant.authority.hostId) throw new HostError('ACCOUNT_LINK_INVALID', 'O serviço respondeu com outra conta')
    return repo.store.transaction(() => {
      const value = repo.save({ ...verified, role: 'linked', isDefault: existing?.isDefault ?? !repo.defaultId(), revision: (existing?.revision ?? -1) + 1 })
      repo.saveLink(value.id, link)
      repo.enable(value.id, true)
      return value
    })
  }
  async call(accountId: string, method: PeerRequest['method'], params: Record<string, unknown>) {
    const account = this.authority.repo.get(accountId), link = this.authority.repo.link(accountId)
    if (account.role !== 'linked' || !link) throw new HostError('ACCOUNT_LINK_INVALID', 'A conta não tem um vínculo remoto válido')
    return callAccountPeer(link, { hostId: this.authority.repo.store.hostId, privateKey: this.keys.privateKey }, account.authorityHostId, method, params)
  }
  revoke(grantId: string) {
    const grant = this.authority.repo.grant(grantId)
    if (!grant) throw new HostError('ACCOUNT_LINK_INVALID', 'O vínculo não foi encontrado')
    if (this.authority.repo.leases(grant.account.id).some(lease => lease.hostId === grant.peerHostId)) throw new HostError('ACCOUNT_BUSY', 'Pare as tarefas deste computador antes de revogar o vínculo')
    this.authority.repo.saveGrant({ ...grant, revoked: true })
    return { revoked: true as const }
  }
  private async handle(packet: PeerRequest, grant: StoredGrant): Promise<unknown> {
    const accountId = grant.account.id
    // Identity and account come only from the verified grant, never from peer params.
    switch (packet.method) {
      case 'inspect': return this.authority.inspect(accountId)
      case 'models': return this.authority.models(accountId)
      case 'credential': return this.authority.credential(accountId, packet.params.forceRefresh, packet.params.credentialHash)
      case 'lease': await this.authority.renewLease(accountId, packet.params, grant.peerHostId); return { applied: true }
      case 'release': await this.authority.releaseLease(accountId, packet.params.turnId, grant.peerHostId); return { applied: true }
    }
  }
  async close() { await this.server?.close() }
}
function publicGrant(grant: StoredGrant): AccountGrant { return { id: grant.id, account: grant.account, authority: grant.authority, peerHostId: grant.peerHostId, expiresAt: grant.expiresAt } }
