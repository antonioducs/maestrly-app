import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DockerError, FakeDockerDriver, type NetworkMember } from '../src/docker.js'
import { findGatewayContainer, gatewayAlias, ownAddresses } from '../src/gateway-container.js'
import { FleetNetwork } from '../src/network.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake Docker whose fleet network lists these members. */
function dockerWith(members: NetworkMember[]) {
  const docker = new FakeDockerDriver()
  docker.networks.add('maestrly-bots')
  docker.networkMembers = async (name) => (name === 'maestrly-bots' ? members : [])
  return docker
}

describe("the gateway's own container", () => {
  it('is the member of the fleet network that holds one of its addresses', async () => {
    const docker = dockerWith([
      { id: 'a'.repeat(64), name: 'maestrly-env-personal', addresses: ['172.30.0.3'] },
      { id: 'b'.repeat(64), name: 'fleet-maestrly-bot-gateway-1', addresses: ['172.30.0.2', 'fd00::2'] },
    ])
    const own = () => new Set(['172.30.0.2'])
    expect(await findGatewayContainer(docker, 'maestrly-bots', null, own)).toBe('b'.repeat(64))
    expect(await findGatewayContainer(docker, 'maestrly-bots', null, () => new Set(['fd00::2']))).toBe('b'.repeat(64))
    expect(await findGatewayContainer(docker, 'maestrly-bots', null, () => new Set(['10.0.0.9']))).toBeNull()
    // The configured one wins, without asking Docker.
    expect(await findGatewayContainer(dockerWith([]), 'maestrly-bots', 'my-gateway', own)).toBe('my-gateway')
  })

  it("reads this process's addresses without loopback, and without IPv4-mapped prefixes or zones", () => {
    const entry = (address: string, internal = false) =>
      ({ address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4' }) as os.NetworkInterfaceInfo
    expect(
      ownAddresses({
        lo: [entry('127.0.0.1', true), entry('::1', true)],
        eth0: [entry('172.30.0.2'), entry('fe80::1%eth0'), entry('::ffff:172.31.0.4')],
      })
    ).toEqual(new Set(['172.30.0.2', 'fe80::1', '172.31.0.4']))
  })

  it('joins under the host name of the internal URL, never under an address', () => {
    expect(gatewayAlias('http://maestrly-bot-gateway:7444')).toBe('maestrly-bot-gateway')
    expect(gatewayAlias('http://gateway.internal:7444')).toBe('gateway.internal')
    expect(gatewayAlias('http://172.30.0.2:7444')).toBeNull()
    expect(gatewayAlias('http://[fd00::2]:7444')).toBeNull()
  })

  it('may be named in the configuration', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-config-'))
    dirs.push(dir)
    expect(loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir }).gatewayContainer).toBeNull()
    expect(loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir, MAESTRLY_GATEWAY_CONTAINER: ' gw-1 ' }).gatewayContainer).toBe(
      'gw-1'
    )
    expect(() => loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir, MAESTRLY_GATEWAY_CONTAINER: 'a b' })).toThrow()
  })
})

describe('the fleet network boundary', () => {
  it('includes the networks of the workspaces environments, and skips those that are gone', async () => {
    const docker = new FakeDockerDriver()
    docker.subnets.set('maestrly-bots', [{ subnet: '172.30.0.0/16', gateway: '172.30.0.1' }])
    docker.subnets.set('maestrly-bots-env-personal', [{ subnet: '172.31.0.0/16', gateway: '172.31.0.1' }])
    const inspect = docker.networkInspect.bind(docker)
    docker.networkInspect = async (name) => {
      if (name === 'maestrly-bots-env-gone') throw new DockerError(404, 'network not found')
      return inspect(name)
    }
    const others = ['maestrly-bots-env-personal', 'maestrly-bots-env-gone']
    const network = new FleetNetwork(docker, 'maestrly-bots', () => others)
    await network.refresh()
    expect(network.insideFleet('172.30.0.5')).toBe(true)
    expect(network.insideFleet('172.31.0.5')).toBe(true)
    // The host side of each bridge is outside: published ports arrive through it.
    expect(network.insideFleet('172.31.0.1')).toBe(false)
    expect(network.insideFleet('10.1.0.5')).toBe(false)
    // Once its network is gone, the environment's addresses are outside again.
    others.splice(0, 1)
    await network.refresh()
    expect(network.insideFleet('172.31.0.5')).toBe(false)
    expect(docker.subnets.get('maestrly-bots')).toHaveLength(1)
  })
})
