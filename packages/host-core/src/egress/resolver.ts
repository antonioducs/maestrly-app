import { lookup } from 'node:dns/promises'
import { connect, type Socket } from 'node:net'
import { EGRESS_LIMITS } from '@maestrly/host-protocol'
import { isForbiddenAddress, normalizeAddress } from './policy.js'

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>
export type Dialer = (address: string, port: number, signal: AbortSignal) => Promise<Socket>
export const systemLookup: Lookup = (hostname) => lookup(hostname, { all: true, verbatim: true })
export const systemDialer: Dialer = (address, port, signal) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, family: normalizeAddress(address)?.family })
    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    signal.addEventListener('abort', () => fail(new Error('Connection timed out')), { once: true })
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.off('error', fail)
      resolve(socket)
    })
  })
/**
 * Resolve once, drop every forbidden address, connect to the pinned address and
 * verify the peer. There is no second resolution, so DNS rebinding cannot redirect
 * an approved hostname to a private or Host address.
 */
export async function pinnedConnect(host: string, port: number, lookupFn: Lookup = systemLookup, dial: Dialer = systemDialer, hostAddresses?: readonly string[]): Promise<Socket> {
  let addresses: { address: string; family: number }[]
  try {
    addresses = await lookupFn(host)
  } catch {
    throw new Error(`DNS_FAILED: ${host} could not be resolved`)
  }
  const allowed = addresses.map((a) => a.address).filter((a) => !isForbiddenAddress(a, hostAddresses))
  if (!allowed.length) throw new Error(`ADDRESS_FORBIDDEN: ${host} resolves only to forbidden addresses`)
  let lastError: Error | undefined
  for (const address of allowed.slice(0, 3)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EGRESS_LIMITS.connectTimeoutMs)
    try {
      const socket = await dial(address, port, controller.signal)
      const peer = socket.remoteAddress ? normalizeAddress(socket.remoteAddress)?.canonical : undefined
      const expected = normalizeAddress(address)?.canonical
      if (!peer || peer !== expected || isForbiddenAddress(peer, hostAddresses)) {
        socket.destroy()
        throw new Error('PEER_MISMATCH: connected peer differs from the approved address')
      }
      return socket
    } catch (error) {
      lastError = error as Error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('CONNECT_FAILED')
}
