import { BlockList, isIP } from 'node:net'
import type { DockerDriver } from './docker.js'
import { GatewayError } from './errors.js'

const remote = (address: string | undefined) => {
  const normalized = address?.startsWith('::ffff:') ? address.slice(7) : (address ?? '')
  return { address: normalized, family: isIP(normalized) }
}

/** Shared network boundary for both gateway APIs and public artifact content. */
export class FleetNetwork {
  private subnets = new BlockList()
  private gateways = new Set<string>()
  constructor(
    private readonly docker: DockerDriver,
    private readonly name: string
  ) {}
  async refresh() {
    const subnets = await this.docker.networkInspect(this.name)
    if (!subnets.length) throw new GatewayError('DOCKER_UNAVAILABLE', 'Fleet network has no subnet')
    const next = new BlockList()
    const gateways = new Set<string>()
    for (const { subnet, gateway } of subnets) {
      const [address, prefix] = subnet.split('/')
      const family = isIP(address)
      if (!family || prefix === undefined) throw new GatewayError('DOCKER_UNAVAILABLE', 'Invalid fleet network subnet')
      next.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6')
      if (gateway && isIP(gateway)) gateways.add(remote(gateway).address)
    }
    this.subnets = next
    this.gateways = gateways
  }
  insideFleet(address: string | undefined): boolean {
    const value = remote(address)
    // Published ports and tailscale serve arrive through the bridge gateway. Bots cannot spoof its TCP handshake.
    return (
      !!value.family &&
      !this.gateways.has(value.address) &&
      this.subnets.check(value.address, value.family === 4 ? 'ipv4' : 'ipv6')
    )
  }
  loopback(address: string | undefined): boolean {
    const value = remote(address)
    return !!value.family && (value.address === '::1' || value.address.startsWith('127.'))
  }
}
