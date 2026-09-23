#!/usr/bin/env node
import { accessSync, constants } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { FLEET_PROTOCOL_VERSION } from '@maestrly/bot-fleet-protocol'
import { Auth } from './auth.js'
import { loadConfig } from './config.js'
import { DockerEngineDriver } from './docker.js'
import { EventHub } from './events.js'
import { HostMonitor } from './host.js'
import { Lifecycle } from './lifecycle.js'
import { Logger } from './logger.js'
import { createGatewayServers } from './server.js'
import { Store } from './store.js'

export async function run(
  argv: string[],
  write: (text: string) => void = console.log,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (argv.includes('--version')) {
    write('0.1.0 (protocol ' + FLEET_PROTOCOL_VERSION + ')')
    return 0
  }
  const command = argv[0] ?? 'serve'
  if (!['serve', 'pair', 'devices', 'doctor'].includes(command)) {
    write('Usage: maestrly-bot-gateway <serve|pair|devices list|devices revoke <id>|doctor>')
    return 1
  }
  const config = loadConfig(env),
    store = new Store(config.dataDir),
    auth = new Auth(store)
  const docker = new DockerEngineDriver(config.dockerSocket),
    host = new HostMonitor(config, docker)
  if (command === 'pair') {
    const pair = auth.createPairing()
    write(pair.code + ' (expires ' + pair.expiresAt + ')')
    store.close()
    return 0
  }
  if (command === 'devices') {
    if (argv[1] === 'list') {
      for (const device of store.listDevices())
        write(
          [device.id, device.name, device.revokedAt ? 'revoked' : 'active', device.lastSeenAt ?? 'never'].join('\t')
        )
      store.close()
      return 0
    }
    if (argv[1] === 'revoke' && argv[2]) {
      const revoked = store.revokeDevice(argv[2])
      write(revoked ? 'Device revoked' : 'Device not found')
      store.close()
      return revoked ? 0 : 1
    }
    write('Usage: devices <list|revoke <id>>')
    store.close()
    return 1
  }
  if (command === 'doctor') {
    let failures = 0
    const check = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
        write('OK ' + label)
      } catch {
        write('FAIL ' + label)
        failures++
      }
    }
    await check('Data directory writable', async () => accessSync(config.dataDir, constants.W_OK))
    await check('Docker socket and API version >= 1.41', () => docker.version())
    await check('Fleet network', () => docker.ensureNetwork(config.network))
    await check('Bot image', async () => {
      if (!(await docker.imageInspect(config.botImage))) throw new Error('Image missing')
    })
    store.close()
    return failures ? 1 : 0
  }
  const logger = new Logger()
  const lifecycle = new Lifecycle(store, docker, config)
  const events = new EventHub(async () => {
    await lifecycle.refreshStats()
    const value = await host.read([...lifecycle.resources.values()].reduce((sum, item) => sum + item.memoryBytes, 0))
    events.emit({ type: 'host.updated', at: new Date().toISOString(), host: value })
  })
  lifecycle.onEvent = (event) => events.emit(event)
  const servers = createGatewayServers({ auth, config, events, host, lifecycle, store })
  await lifecycle.reconcile()
  await servers.listen()
  logger.info('Gateway listening', { publicPort: config.publicPort, internalPort: config.internalPort })
  const close = () => {
    void servers.close().then(() => store.close())
  }
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
  return 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch(() => {
      console.error('Gateway startup failed')
      process.exitCode = 1
    })
}
