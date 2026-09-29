import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { FakeDockerDriver } from '../src/docker.js'
import { getGatewayVersion, HostMonitor } from '../src/host.js'
import { run } from '../src/main.js'
import { harness } from './harness.js'

const packageVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version

const dirs: string[] = []
function temp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-image-version-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('gateway version', () => {
  it('uses the image build version and falls back to the package version', () => {
    expect(getGatewayVersion({ MAESTRLY_GATEWAY_VERSION: ' 0.9.2 ' })).toBe('0.9.2')
    expect(getGatewayVersion({})).toBe(packageVersion)
  })

  it('prints the same version from the CLI', async () => {
    const lines: string[] = []
    expect(
      await run(['--version'], (line) => lines.push(line), {
        MAESTRLY_GATEWAY_VERSION: '0.9.2',
      })
    ).toBe(0)
    expect(lines).toEqual(['0.9.2 (protocol 1)'])
  })
})

describe('available bot image version', () => {
  it('reports the configured image label and refreshes it when the image changes', async () => {
    const driver = new FakeDockerDriver()
    const inspect = vi.spyOn(driver, 'imageInspect').mockResolvedValue({ id: 'sha256:first', version: '1.2.3' })
    const config = loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: temp(), MAESTRLY_GATEWAY_BOT_IMAGE: 'test:latest' })
    const host = new HostMonitor(config, driver)
    expect((await host.read()).botImageVersion).toBe('1.2.3')
    expect(inspect).toHaveBeenCalledWith('test:latest')
    inspect.mockResolvedValue({ id: 'sha256:second', version: '1.2.4' })
    expect((await host.read()).botImageVersion).toBe('1.2.4')
  })

  it('keeps host information available for unlabeled, missing or unreachable images', async () => {
    const driver = new FakeDockerDriver()
    const inspect = vi.spyOn(driver, 'imageInspect').mockResolvedValue({ id: 'sha256:unlabeled' })
    const host = new HostMonitor(loadConfig({ MAESTRLY_GATEWAY_DATA_DIR: temp() }), driver)
    expect((await host.read()).botImageVersion).toBeNull()
    inspect.mockResolvedValue(null)
    expect((await host.read()).botImageVersion).toBeNull()
    inspect.mockRejectedValue(new Error('Synthetic Docker outage'))
    expect((await host.read()).botImageVersion).toBeNull()
  })

  it('returns the image version in gateway metadata', async () => {
    const fleet = await harness()
    vi.spyOn(FakeDockerDriver.prototype, 'imageInspect').mockResolvedValue({ id: 'sha256:image', version: '1.2.3' })
    const response = await fleet.request('GET', '/v1/meta')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ botImageVersion: '1.2.3' })
  })

  it('reports the gateway version in gateway metadata', async () => {
    vi.stubEnv('MAESTRLY_GATEWAY_VERSION', '9.8.7')
    try {
      const fleet = await harness()
      const meta = await (await fleet.request('GET', '/v1/meta')).json()
      expect(meta.gatewayVersion).toBe('9.8.7')
      expect(meta.features).toContain('environment-updates')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
