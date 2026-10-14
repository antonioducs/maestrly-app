import os from 'node:os'
import type { DockerDriver } from './docker.js'

const bare = (address: string) => (address.startsWith('::ffff:') ? address.slice(7) : address).split('%')[0]

/** This process's own addresses, without loopback ones. */
export function ownAddresses(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()
): Set<string> {
  const addresses = new Set<string>()
  for (const entries of Object.values(interfaces))
    for (const entry of entries ?? []) if (!entry.internal) addresses.add(bare(entry.address))
  return addresses
}

/**
 * Finds the gateway's own container: the one named by `MAESTRLY_GATEWAY_CONTAINER` when set, otherwise the member of
 * the fleet network that holds one of this process's addresses. Null when the gateway does not run in a container on
 * that network (it then cannot reach the environments by name either).
 */
export async function findGatewayContainer(
  docker: DockerDriver,
  network: string,
  configured: string | null,
  addresses: () => Set<string> = () => ownAddresses()
): Promise<string | null> {
  if (configured) return configured
  const own = addresses()
  const member = (await docker.networkMembers(network)).find((item) =>
    item.addresses.some((address) => own.has(bare(address)))
  )
  return member?.id ?? null
}

/** The host name the environments call the gateway by: its internal URL's, unless that names an address. */
export function gatewayAlias(internalUrl: string): string | null {
  const host = new URL(internalUrl).hostname
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host) &&
    !/^\d+(\.\d+){3}$/.test(host)
    ? host
    : null
}
