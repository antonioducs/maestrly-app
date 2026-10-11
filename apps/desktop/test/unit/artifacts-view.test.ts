import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { fleetActivitySegments } from '../../src/renderer/lib/agent-activity'
import { describe, expect, it } from 'vitest'
import {
  ALL_PROJECTS,
  artifactSource,
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
import type { ArtifactListItem, ArtifactServerStatus } from '../../src/shared/artifacts'

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
    bot: null,
    elsewhere: false,
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

const ready: ArtifactServerStatus = {
  state: 'ready',
  canOpen: true,
  canMove: true,
  artifactCount: 1,
  storageBytes: 10,
  quotaBytes: 100,
  problem: null,
}

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

  it('warns near the storage limit of the bot server', () => {
    expect(nearQuota({ ...ready, storageBytes: 89 })).toBe(false)
    expect(nearQuota({ ...ready, storageBytes: 90 })).toBe(true)
    expect(nearQuota({ state: 'off', canMove: true })).toBe(false)
    expect(nearQuota(null)).toBe(false)
  })

  it('explains every state of the bot server instead of claiming there are no artifacts', () => {
    const body = (input: Partial<Parameters<typeof centerBody>[0]>) =>
      centerBody({ loading: false, server: ready, listed: true, total: 0, visible: 0, ...input })
    expect(body({ loading: true })).toEqual({ kind: 'loading' })
    const reasons: [ArtifactServerStatus | null, string][] = [
      [{ state: 'absent' }, 'absent'],
      [{ state: 'unsupported' }, 'unsupported'],
      [{ state: 'unreachable' }, 'unreachable'],
      [{ state: 'off', canMove: true }, 'off'],
      [{ ...ready, problem: 'port_in_use' }, 'problem'],
      [null, 'unreachable'],
    ]
    for (const [server, reason] of reasons)
      expect(body({ server, listed: false }), reason).toEqual({ kind: 'unavailable', reason })
    // A ready server that could not list says so, rather than "no artifacts".
    expect(body({ listed: false })).toEqual({ kind: 'unavailable', reason: 'unreachable' })
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

describe('artifact sources', () => {
  it('labels bots and other computers, and nothing else', () => {
    expect(artifactSource(item('a'))).toBe('own')
    expect(artifactSource(item('a', { elsewhere: true }))).toBe('elsewhere')
    expect(artifactSource(item('a', { bot: { id: 'bot', name: null }, elsewhere: true }))).toBe('bot')
  })
})

it('keeps normalized artifact tool results outside compact bot activity', () => {
  for (const name of ['artifact_create', 'mcp__maestrly__artifact_update']) {
    const artifact: FleetTranscriptItem = {
      kind: 'tool',
      id: 'm1:0',
      at: '2026-09-30T12:00:00Z',
      name,
      target: null,
      state: 'done',
      output: '{"id":"page","title":"Page","version":1}',
      images: [],
    }
    const following: FleetTranscriptItem = { ...artifact, id: 'm1:1', name: 'bash', output: null }
    const segments = fleetActivitySegments([artifact, following], { working: false })
    expect(segments.some((segment) => segment.kind === 'item' && segment.item.id === artifact.id)).toBe(true)
    expect(
      segments
        .filter((segment) => segment.kind === 'activity')
        .flatMap((segment) => segment.steps)
        .some((step) => step.id === artifact.id)
    ).toBe(false)
  }
})
