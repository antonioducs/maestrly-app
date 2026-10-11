/**
 * The channel policy is checked against the preload itself: every member of each slice is called with a recording
 * transport, so a member added later lands in one side of the policy or fails here.
 */
import * as electron from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appApi } from '../../src/preload/api-app'
import { artifactsApi } from '../../src/preload/api-artifacts'
import { chatLocalApi } from '../../src/preload/api-chat'
import { chatWindowApi } from '../../src/preload/api-chat-window'
import { drawerApi } from '../../src/preload/api-drawer'
import { fleetApi } from '../../src/preload/api-fleet'
import { fleetEnvironmentSettings } from '../../src/preload/api-fleet-environment-settings'
import { fleetInstallerApi } from '../../src/preload/api-fleet-installer'
import { hostsApi } from '../../src/preload/api-hosts'
import { performanceApi } from '../../src/preload/api-performance'
import { transfersApi } from '../../src/preload/api-transfers'
import { platformLocalApi } from '../../src/preload/api-platform'
import { popupApi } from '../../src/preload/api-popup'
import { settingsApi } from '../../src/preload/api-settings'
import { soundApi } from '../../src/preload/api-sound'
import { updateApi } from '../../src/preload/api-update'
import { makeHostApi } from '../../src/preload/host-api'
import { HOST_DESKTOP_EFFECT_CHANNELS, remoteChannelRefusal } from '../../src/shared/host-channels'

// Stands for any argument: a callable object whose every property is itself, and which prints as a string.
const dummy: any = new Proxy(() => {}, {
  get: (_target, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => 'x' : dummy),
  apply: () => dummy,
})

/** The channels each member of a slice invokes or sends on, in member order. */
function channelsOf(slice: Record<string, unknown>, seen: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [name, member] of Object.entries(slice)) {
    if (typeof member !== 'function') continue
    const before = seen.length
    try {
      const result = (member as (...args: unknown[]) => unknown)(dummy, dummy, dummy, dummy)
      if (result && typeof (result as Promise<unknown>).catch === 'function')
        (result as Promise<unknown>).catch(() => {})
    } catch {
      /* A member that rejects the dummy argument before calling has no channel to classify. */
    }
    out.set(name, seen.slice(before))
  }
  return out
}

afterEach(() => vi.restoreAllMocks())

describe('host channel policy', () => {
  it('lets remote origins use every host channel except desktop effects', () => {
    const seen: string[] = []
    const byMember = channelsOf(
      makeHostApi({
        invoke: async (channel) => void seen.push(channel),
        send: (channel) => void seen.push(channel),
        on: () => {},
        removeListener: () => {},
      }),
      seen
    )
    const channels = new Set([...byMember.values()].flat())
    expect(channels.size).toBeGreaterThan(250)
    const refused = [...byMember].flatMap(([member, used]) =>
      used.filter((channel) => remoteChannelRefusal(channel) === 'local-only').map((channel) => `${member}: ${channel}`)
    )
    expect(refused).toEqual([])
    expect([...HOST_DESKTOP_EFFECT_CHANNELS].filter((channel) => !channels.has(channel))).toEqual([])
    for (const channel of HOST_DESKTOP_EFFECT_CHANNELS) expect(remoteChannelRefusal(channel)).toBe('desktop-effect')
  })

  it("refuses every channel of this computer's local API", () => {
    const seen: string[] = []
    vi.spyOn(electron.ipcRenderer, 'invoke').mockImplementation(async (channel: string) => void seen.push(channel))
    vi.spyOn(electron.ipcRenderer, 'send').mockImplementation((channel: string) => void seen.push(channel))
    const local = {
      ...appApi,
      ...performanceApi,
      ...drawerApi,
      ...popupApi,
      ...settingsApi,
      ...soundApi,
      ...updateApi,
      ...chatLocalApi,
      ...chatWindowApi,
      ...platformLocalApi,
      ...fleetApi,
      ...fleetEnvironmentSettings,
      ...fleetInstallerApi,
      ...hostsApi,
      ...artifactsApi,
      ...transfersApi,
    }
    const byMember = channelsOf(local, seen)
    expect(new Set([...byMember.values()].flat()).size).toBeGreaterThan(100)
    const allowed = [...byMember].flatMap(([member, used]) =>
      used.filter((channel) => remoteChannelRefusal(channel) !== 'local-only').map((channel) => `${member}: ${channel}`)
    )
    expect(allowed).toEqual([])
  })

  it('treats an unknown channel as a host channel, left for the handler table to refuse', () => {
    expect(remoteChannelRefusal('workspace:list')).toBeNull()
    expect(remoteChannelRefusal('no-such:channel')).toBeNull()
  })
})
