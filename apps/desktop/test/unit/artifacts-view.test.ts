import { describe, expect, it } from 'vitest'
import {
  ALL_PROJECTS,
  arrivals,
  centerBody,
  matchesProject,
  nearQuota,
  projectFilter,
  projectOptions,
  STANDALONE,
  showToolbar,
  visibleArtifacts,
} from '../../src/renderer/components/artifacts/artifacts-view'
import type { ArtifactHostStatus, ArtifactListItem } from '../../src/shared/artifacts'

function item(id: string, overrides: Partial<ArtifactListItem> = {}): ArtifactListItem {
  return {
    id,
    title: `Title ${id}`,
    description: '',
    currentVersion: 1,
    versionCount: 1,
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
    host: 'local',
    conversation: null,
    project: { id: 'p1', name: 'Zeta' },
    storageBytes: 10,
    thumbnailVersion: null,
    unseenEvents: 0,
    pendingRequests: 0,
    openComments: 0,
    ...overrides,
  }
}

const running: ArtifactHostStatus = { state: 'running', port: 4010, storageBytes: 10, quotaBytes: 100 }

describe('artifacts center view', () => {
  it('filters by project, standalone conversations, and search over title and description', () => {
    const items = [
      item('a', { title: 'Token dashboard' }),
      item('b', { project: { id: 'p2', name: 'Alpha' }, description: 'Sign-in prototype' }),
      item('c', { project: null, title: 'Latency chart' }),
    ]
    expect(matchesProject(items[2]!, STANDALONE)).toBe(true)
    expect(matchesProject(items[0]!, projectFilter('p2'))).toBe(false)
    const view = (query: string, project = ALL_PROJECTS) =>
      visibleArtifacts(items, { query, project, sort: 'title', locale: 'en' }).map((entry) => entry.id)
    expect(view('')).toEqual(['c', 'b', 'a'])
    expect(view('SIGN-IN')).toEqual(['b'])
    expect(view('', projectFilter('p1'))).toEqual(['a'])
    expect(view('', STANDALONE)).toEqual(['c'])
    expect(view('token', projectFilter('p2'))).toEqual([])
  })

  it('sorts by update, creation, title and storage', () => {
    const items = [
      item('a', { title: 'b', updatedAt: 3, createdAt: 1, storageBytes: 5 }),
      item('b', { title: 'a', updatedAt: 1, createdAt: 3, storageBytes: 50 }),
      item('c', { title: 'c', updatedAt: 2, createdAt: 2, storageBytes: 20 }),
    ]
    const sorted = (sort: 'updated' | 'created' | 'title' | 'size') =>
      visibleArtifacts(items, { query: '', project: ALL_PROJECTS, sort, locale: 'en' }).map((entry) => entry.id)
    expect(sorted('updated')).toEqual(['a', 'c', 'b'])
    expect(sorted('created')).toEqual(['b', 'c', 'a'])
    expect(sorted('title')).toEqual(['b', 'a', 'c'])
    expect(sorted('size')).toEqual(['b', 'c', 'a'])
  })

  it('offers every project by name, a removed one last, then standalone conversations', () => {
    const options = projectOptions(
      [
        item('a'),
        item('b', { project: { id: 'p2', name: 'Alpha' } }),
        item('c', { project: { id: 'gone', name: null } }),
        item('d', { project: null }),
        item('e'),
      ],
      'en'
    )
    expect(options.map((option) => [option.value, option.name, option.count])).toEqual([
      ['all', null, 5],
      ['project:p2', 'Alpha', 1],
      ['project:p1', 'Zeta', 2],
      ['project:gone', null, 1],
      ['standalone', null, 1],
    ])
    expect(projectOptions([item('a')], 'en').some((option) => option.kind === 'standalone')).toBe(false)
  })

  it('shows search and filters only for a list worth searching, or while they are in use', () => {
    expect(showToolbar(3, '', ALL_PROJECTS)).toBe(false)
    expect(showToolbar(4, '', ALL_PROJECTS)).toBe(true)
    expect(showToolbar(1, 'x', ALL_PROJECTS)).toBe(true)
    expect(showToolbar(1, '', STANDALONE)).toBe(true)
  })

  it('warns near the storage limit only while the host runs', () => {
    expect(nearQuota({ ...running, storageBytes: 89 })).toBe(false)
    expect(nearQuota({ ...running, storageBytes: 90 })).toBe(true)
    expect(nearQuota({ state: 'error', problem: 'crashed', port: 4010, storageBytes: 99, quotaBytes: 100 })).toBe(false)
    expect(nearQuota(null)).toBe(false)
  })

  it('never claims there are no artifacts when the host could not list them', () => {
    const body = (input: Partial<Parameters<typeof centerBody>[0]>) =>
      centerBody({ loading: false, status: running, listed: true, total: 0, visible: 0, ...input })
    expect(body({ loading: true })).toEqual({ kind: 'loading' })
    expect(body({ status: { state: 'starting', port: 4010 } })).toEqual({ kind: 'loading' })
    expect(body({ status: { state: 'error', problem: 'port_in_use', port: 4010 }, listed: false })).toEqual({
      kind: 'unavailable',
      reason: 'port_in_use',
    })
    expect(body({ status: { state: 'stopped', problem: 'disabled', port: 4010 }, listed: false })).toEqual({
      kind: 'unavailable',
      reason: 'disabled',
    })
    expect(body({ status: { state: 'stopped', port: 4010 }, listed: false })).toEqual({
      kind: 'unavailable',
      reason: 'stopped',
    })
    expect(body({})).toEqual({ kind: 'empty' })
    expect(body({ total: 2, visible: 0 })).toEqual({ kind: 'no-match' })
    expect(body({ total: 2, visible: 2 })).toEqual({ kind: 'grid' })
  })

  it('marks artifacts that appear and artifacts that gain a version', () => {
    const before = [item('a'), item('b', { currentVersion: 2 })]
    const after = [item('a'), item('b', { currentVersion: 3 }), item('c')]
    expect([...arrivals(before, after)]).toEqual([
      ['b', 'version'],
      ['c', 'artifact'],
    ])
    expect(arrivals(after, before).size).toBe(0)
  })
})
