import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostView } from '../../src/shared/hosts'
import { hostRetryable, hostSectionStatus } from '../../src/renderer/lib/hosts/host-status'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const host = (patch: Partial<HostView>): HostView => ({
  id: 'server-1/workspaces',
  remote: true,
  label: 'vps',
  server: 'vps',
  serverId: 'server-1' as FleetServerId,
  tint: null,
  state: 'online',
  epoch: 1,
  os: 'linux',
  homeDir: '/home/bot',
  desktopEffects: false,
  editor: false,
  browser: false,
  computer: false,
  folderTransfers: false,
  environment: { id: 'workspaces', lifecycle: 'running', updateAvailable: false },
  peer: null,
  hostVersion: null,
  ...patch,
})

describe('host section status', () => {
  it('follows the connection while there is one to follow', () => {
    for (const state of ['online', 'connecting', 'reconnecting', 'incompatible'] as const)
      expect(hostSectionStatus(host({ state }))).toBe(state)
  })

  it('says what the environment does on the server while the host is not reached at all', () => {
    const offline = (lifecycle: string | null) =>
      hostSectionStatus(
        host({ state: 'offline', environment: lifecycle ? { id: 'w', lifecycle, updateAvailable: false } : null })
      )
    expect(offline('stopped')).toBe('stopped')
    expect(offline('stopping')).toBe('stopped')
    expect(offline('creating')).toBe('starting')
    expect(offline('starting')).toBe('starting')
    expect(offline('restarting')).toBe('starting')
    expect(offline('failed')).toBe('failed')
    expect(offline('running')).toBe('offline')
    expect(offline(null)).toBe('offline')
  })

  it('says what a paired computer answered until it answers again, over how it is reached', () => {
    const peer = (state: HostView['state'], problem: NonNullable<HostView['peer']>['problem']) =>
      hostSectionStatus(host({ state, environment: null, peer: { deviceId: 'd', problem } }))
    for (const problem of ['not-hosting', 'removed', 'disconnected', 'identity-changed'] as const) {
      expect(peer('offline', problem)).toBe(problem)
      expect(peer('reconnecting', problem)).toBe(problem)
    }
    expect(peer('online', 'removed')).toBe('online')
    expect(peer('incompatible', null)).toBe('incompatible')
    expect(peer('offline', null)).toBe('offline')
    expect(peer('connecting', null)).toBe('connecting')
  })

  it('offers to dial again only where it may help', () => {
    expect(hostRetryable('offline')).toBe(true)
    expect(hostRetryable('not-hosting')).toBe(true)
    expect(hostRetryable('disconnected')).toBe(true)
    // A computer that removed this one, or answers with another identity, needs a new pairing.
    expect(hostRetryable('removed')).toBe(false)
    expect(hostRetryable('identity-changed')).toBe(false)
    expect(hostRetryable('stopped')).toBe(false)
  })
})

describe('hosts of the window', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  async function probe(hostId?: string) {
    const { useHostInfo, useHosts } = await import('../../src/renderer/lib/hosts/use-hosts')
    function Probe() {
      const info = useHostInfo(hostId)
      const ids = useHosts().map((item) => item.id)
      return createElement('p', null, JSON.stringify({ ids, info }))
    }
    const markup = renderToStaticMarkup(createElement(Probe))
    return JSON.parse(markup.slice(3, -4).replaceAll('&quot;', '"')) as { ids: string[]; info: HostView }
  }

  it('is this computer alone where there is no window, as in static markup', async () => {
    const { ids, info } = await probe()
    expect(ids).toEqual(['local'])
    expect(info).toMatchObject({ id: 'local', remote: false, state: 'online', desktopEffects: true })
  })

  it("takes this computer's system from the preload, without asking the main process while rendering", async () => {
    const hostsList = vi.fn()
    vi.stubGlobal('window', { api: { platformInfo: { os: 'win' }, hostsList, onHostsChanged: vi.fn() } })
    const { info } = await probe()
    expect(info.os).toBe('win')
    expect(hostsList).not.toHaveBeenCalled()
  })

  it('describes a host it does not know as one that cannot be reached, with no desktop to act on', async () => {
    const { info } = await probe('server-1/gone')
    expect(info).toMatchObject({ id: 'server-1/gone', remote: true, state: 'offline', desktopEffects: false })
  })
})
