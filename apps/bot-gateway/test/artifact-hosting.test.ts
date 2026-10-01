import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { ArtifactHosting } from '../src/artifact-hosting.js'
import { FleetNetwork } from '../src/network.js'
import { Store } from '../src/store.js'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

test('network shares the bridge gateway exemption and normalizes mapped IPv4', async () => {
  const network = new FleetNetwork(new FakeDockerDriver(), 'maestrly-bots')
  await network.refresh()
  expect(network.insideFleet('172.30.0.2')).toBe(true)
  expect(network.insideFleet('::ffff:172.30.0.2')).toBe(true)
  expect(network.insideFleet('172.30.0.1')).toBe(false)
  expect(network.loopback('::ffff:127.0.0.1')).toBe(true)
  expect(network.loopback(undefined)).toBe(false)
})

test('settings persist, concurrent patches compose, and host can restart after disabling', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-artifacts-'))
  const config = { ...loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir }), artifactsPort: 0 }
  const store = new Store(dir)
  const network = new FleetNetwork(new FakeDockerDriver(), config.network)
  await network.refresh()
  const toggles: boolean[] = []
  const hosting = new ArtifactHosting({
    store,
    config,
    network,
    emit: () => {},
    onEnabledChange: () => {
      toggles.push(hosting.settings().enabled)
    },
  })
  cleanups.push(async () => {
    await hosting.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  expect((await hosting.state()).status.state).toBe('off')
  await Promise.all([hosting.update({ enabled: true }), hosting.update({ ownerName: 'Test owner' })])
  expect((await hosting.state()).status.state).toBe('running')
  expect(hosting.settings()).toMatchObject({ enabled: true, ownerName: 'Test owner', quotaGb: 2, linkExpiryDays: 30 })
  expect(store.getMetaJson('artifact_settings')).toMatchObject({ enabled: true, ownerName: 'Test owner' })
  await hosting.update({ enabled: false })
  expect(hosting.admin()).toBe(null)
  await hosting.update({ enabled: true })
  expect((await hosting.state()).status.state).toBe('running')
  expect(toggles).toEqual([true, false, true])
})

test('a failed settings write leaves the current settings intact and the queue usable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-artifacts-'))
  const config = { ...loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: dir }), artifactsPort: 0 }
  const store = new Store(dir)
  const hosting = new ArtifactHosting({
    store,
    config,
    network: new FleetNetwork(new FakeDockerDriver(), config.network),
    emit: () => {},
  })
  cleanups.push(async () => {
    await hosting.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const write = store.setMetaJson.bind(store)
  store.setMetaJson = () => {
    throw new Error('Synthetic write failure')
  }
  await expect(hosting.update({ ownerName: 'Lost' })).rejects.toThrow('Synthetic write failure')
  expect(hosting.settings().ownerName).toBe('')
  store.setMetaJson = write
  await hosting.update({ ownerName: 'Saved' })
  expect(hosting.settings().ownerName).toBe('Saved')
})
