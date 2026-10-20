import { FLEET_INSTANCE_BRIDGE_PATH, FLEET_PROTOCOL_HEADER, FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'
import { WebSocket, type ClientOptions } from 'ws'
import type { PeerProblem } from '../../shared/peer'
import { REMOTE_BRIDGE_LIMITS } from '../../shared/remote-bridge'
import type { BridgeClientSocket } from '../remote-host/client/host-connection'
import { PeerUnreachable, reachPeer } from './dial'
import { pinnedTls, urlHost } from './http'
import type { PeerRecord } from './schemas'
import type { PeerStore } from './store'

/** Where this computer reaches a paired one for files and the editor: its origin, credentials, and certificate. */
export interface PeerEndpoint {
  origin: string
  headers(): Record<string, string>
  certPem: string
}

export interface PeerHostsDeps {
  store: Pick<PeerStore, 'list' | 'get' | 'tokenFor' | 'touch' | 'onChange'>
  reach?: (candidates: string[], port: number, certPem: string) => Promise<string>
  openSocket?: (url: string, options: ClientOptions) => WebSocket
  now?: () => number
}

/**
 * The owner's other computers as hosts of this one's windows: each bridge is opened at the address that shows the
 * certificate pinned at pairing, with the token that computer issued. What a computer says when it refuses (removed
 * this one, not hosting, another identity) is kept for the window to show.
 */
export class PeerHosts {
  private readonly problems = new Map<string, PeerProblem>()
  private readonly reached = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly reach: NonNullable<PeerHostsDeps['reach']>
  private readonly openSocket: NonNullable<PeerHostsDeps['openSocket']>
  private readonly now: () => number

  constructor(private readonly deps: PeerHostsDeps) {
    this.reach = deps.reach ?? ((candidates, port, certPem) => reachPeer(candidates, port, certPem))
    this.openSocket = deps.openSocket ?? ((url, options) => new WebSocket(url, options))
    this.now = deps.now ?? Date.now
  }

  list(): PeerRecord[] {
    return this.deps.store.list()
  }

  problem(deviceId: string): PeerProblem {
    return this.problems.get(deviceId) ?? null
  }

  /** Calls `listener` when the paired computers or what they said changes; returns its removal. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    const stopStore = this.deps.store.onChange(listener)
    return () => {
      this.listeners.delete(listener)
      stopStore()
    }
  }

  async connect(deviceId: string): Promise<BridgeClientSocket> {
    const record = this.deps.store.get(deviceId)
    const token = this.deps.store.tokenFor(deviceId)
    if (!record || !token) throw new Error('Unknown computer')
    let address: string
    try {
      address = await this.reach(record.addresses, record.port, record.certPem)
    } catch (error) {
      if (error instanceof PeerUnreachable) {
        if (error.identityChanged) this.setProblem(deviceId, 'identity-changed')
        else if (error.refused) this.setProblem(deviceId, 'not-hosting')
      }
      throw error
    }
    this.reached.set(deviceId, address)
    this.deps.store.touch(deviceId, this.now(), address)
    const options = {
      headers: { [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION), Authorization: `Bearer ${token}` },
      maxPayload: REMOTE_BRIDGE_LIMITS.maxFrameBytes,
      // ws hands these to tls.connect, which takes Node's checkServerIdentity; @types/ws declares an older one.
      ...pinnedTls(record.certPem),
    } as unknown as ClientOptions
    const socket = this.openSocket(`wss://${urlHost(address)}:${record.port}${FLEET_INSTANCE_BRIDGE_PATH}`, options)
    // A refused handshake ends with an error the connection reads itself; it must never go unhandled here.
    socket.on('error', () => undefined)
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401) this.setProblem(deviceId, 'removed')
      response.resume()
      socket.terminate()
    })
    socket.on('open', () => this.setProblem(deviceId, null))
    return socket as unknown as BridgeClientSocket
  }

  endpoint(deviceId: string): PeerEndpoint | null {
    const record = this.deps.store.get(deviceId)
    const address = this.reached.get(deviceId) ?? record?.addresses[0]
    if (!record || !address) return null
    return {
      origin: `https://${urlHost(address)}:${record.port}`,
      headers: () => ({
        [FLEET_PROTOCOL_HEADER]: String(FLEET_PROTOCOL_VERSION),
        Authorization: `Bearer ${this.deps.store.tokenFor(deviceId) ?? ''}`,
      }),
      certPem: record.certPem,
    }
  }

  private setProblem(deviceId: string, problem: PeerProblem): void {
    if (this.problem(deviceId) === problem) return
    if (problem) this.problems.set(deviceId, problem)
    else this.problems.delete(deviceId)
    for (const listener of [...this.listeners]) listener()
  }
}
