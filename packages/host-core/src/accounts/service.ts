import { accountResultSchemas, type BotRequest, type SharedAccount } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { AccountAuthority } from './authority.js'
import type { AccountPeers } from './peers.js'
/** Account RPCs are administrative and never accept raw credential-export requests. */
export class AccountService {
  constructor(readonly authority: AccountAuthority, readonly peers: AccountPeers, private migrate: (botId: string, key: string) => Promise<SharedAccount>) {}
  async handle(request: BotRequest) {
    const p = request.params as any
    let result: unknown
    switch (request.method) {
      case 'account.list': result = this.authority.list(); break
      case 'account.create': result = this.authority.create(p); break
      case 'account.inspect': result = await this.authority.inspect(p.accountId); break
      case 'account.models': result = await this.authority.models(p.accountId); break
      case 'account.impact': result = this.authority.impact(p.accountId); break
      case 'account.default': result = this.authority.setDefault(p.accountId); break
      case 'account.start': result = await this.authority.start(p.accountId); break
      case 'account.cancel': result = await this.authority.cancel(p.accountId); break
      case 'account.logout': result = await this.authority.logout(p.accountId); break
      case 'account.setApiKey': result = await this.authority.setApiKey(p.accountId, p.apiKey); break
      case 'account.migrate': result = await this.migrate(p.botId, p.idempotencyKey); break
      case 'account.peer.identity': result = await this.peers.identity(); break
      case 'account.peer.grant': result = await this.peers.grant(p); break
      case 'account.peer.link': result = await this.peers.link(p); break
      case 'account.peer.revoke': result = this.peers.revoke(p.grantId); break
      default: throw new HostError('INVALID_REQUEST', 'Método de conta desconhecido')
    }
    return accountResultSchemas[request.method].parse(result)
  }
}
