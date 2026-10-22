import { describe, expect, it } from 'vitest'
import { hostActivity, hostGroups, resolveSidebarHost } from '../../src/renderer/components/sidebar/sidebar-hosts'
import type { HostView } from '../../src/shared/hosts'
import { compactAge } from '../../src/renderer/components/sidebar/relative-time'
import en from '../../src/shared/i18n/en/ui'
import ptBR from '../../src/shared/i18n/pt-BR/ui'

const conv = (id: string, status = 'idle', archived = 0) => ({ id, status, archived })

describe('sidebar hosts', () => {
  it('counts what waits for the person and what runs, from live statuses over stored ones', () => {
    const activity = hostActivity(
      [conv('a', 'working'), conv('b', 'idle'), conv('c', 'ready'), conv('d', 'working', 1), conv('e', 'idle', 1)],
      { b: 'working', c: 'ready' },
      new Set(['c', 'e', 'elsewhere'])
    )
    // `a` runs by its stored status, `b` by its live one; archived `d` and `e` count for nothing.
    expect(activity).toEqual({ attention: 1, working: 2 })
    expect(hostActivity([], {}, new Set())).toEqual({ attention: 0, working: 0 })
  })

  it('lists the machines of each bot server under its name once there are several servers', () => {
    const host = (id: string, serverId: string | null, server = '') => ({ id, serverId, server }) as unknown as HostView
    const local = host('local', null)
    const laptop = host('peer:laptop', null)
    const one = [local, host('s1/personal', 's1', 'mac-mini'), host('s1/work', 's1', 'mac-mini'), laptop]
    expect(hostGroups(one)).toEqual([{ serverId: null, server: '', hosts: one }])
    const two = [
      local,
      host('s1/personal', 's1', 'mac-mini'),
      host('s2/work', 's2', ''),
      laptop,
      host('s2/ads', 's2', 'vps'),
    ]
    expect(hostGroups(two).map((group) => [group.serverId, group.server, group.hosts.map((item) => item.id)])).toEqual([
      [null, '', ['local', 'peer:laptop']],
      ['s1', 'mac-mini', ['s1/personal']],
      // A server is named by the first of its hosts that knows its name.
      ['s2', 'vps', ['s2/work', 's2/ads']],
    ])
  })

  it('keeps the chosen machine while it is listed and falls back to this computer otherwise', () => {
    const listed = ['local', 'server-1/workspaces']
    expect(resolveSidebarHost('server-1/workspaces', listed)).toBe('server-1/workspaces')
    expect(resolveSidebarHost('local', listed)).toBe('local')
    // Not listed (yet, or any more), or never chosen.
    expect(resolveSidebarHost('server-2/workspaces', listed)).toBe('local')
    expect(resolveSidebarHost(null, listed)).toBe('local')
    expect(resolveSidebarHost('server-1/workspaces', ['local'])).toBe('local')
  })

  it('names a machine in both languages', () => {
    for (const catalog of [en, ptBR]) {
      for (const key of [
        'hostMachines',
        'hostSwitch',
        'hostOthers',
        'hostSwitchTo',
        'hostOnline',
        'hostNeedsYou_one',
        'hostNeedsYou_other',
        'hostRunning_one',
        'hostRunning_other',
        'hostResults_one',
        'hostResults_other',
        'hostResultsHere_one',
        'hostResultsHere_other',
        'viewOptions',
        'needsAttention',
      ] as const)
        expect(catalog.sidebar[key], key).toEqual(expect.any(String))
    }
    expect(en.sidebar.hostSwitch).toContain('{{host}}')
    expect(ptBR.sidebar.hostResults_other).toBe('{{count}} resultados em {{host}}')
  })
})

describe('compact age', () => {
  const now = Date.UTC(2026, 9, 13, 12)
  const ago = (ms: number) => compactAge(now - ms, now)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  it('uses the largest whole unit', () => {
    expect(ago(20_000)).toEqual({ unit: 'Now' })
    expect(ago(5 * minute)).toEqual({ unit: 'Minutes', count: 5 })
    expect(ago(59 * minute)).toEqual({ unit: 'Minutes', count: 59 })
    expect(ago(3 * hour)).toEqual({ unit: 'Hours', count: 3 })
    expect(ago(6 * day)).toEqual({ unit: 'Days', count: 6 })
    expect(ago(7 * day)).toEqual({ unit: 'Weeks', count: 1 })
    expect(ago(29 * day)).toEqual({ unit: 'Weeks', count: 4 })
    expect(ago(45 * day)).toEqual({ unit: 'Months', count: 1 })
    expect(ago(400 * day)).toEqual({ unit: 'Years', count: 1 })
  })

  it('has nothing to say without a timestamp, and treats another clock ahead of ours as now', () => {
    expect(compactAge(0, now)).toBeNull()
    expect(ago(-5 * minute)).toEqual({ unit: 'Now' })
  })

  it('has a short label for every unit in both languages', () => {
    for (const catalog of [en, ptBR]) {
      const { sidebar } = catalog
      for (const label of [
        sidebar.ageNow,
        sidebar.ageMinutes,
        sidebar.ageHours,
        sidebar.ageDays,
        sidebar.ageWeeks,
        sidebar.ageMonths_one,
        sidebar.ageMonths_other,
        sidebar.ageYears_one,
        sidebar.ageYears_other,
      ])
        expect(label.length).toBeGreaterThan(0)
    }
    expect(en.sidebar.ageWeeks).toBe('{{count}}w')
    expect(ptBR.sidebar.ageWeeks).toBe('{{count}}sem')
  })
})
