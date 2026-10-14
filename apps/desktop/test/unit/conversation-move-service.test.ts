import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { MoveEndpoint } from '../../src/main/conversation-move/endpoint'
import { MoveError } from '../../src/main/conversation-move/errors'
import type { PackageRelay } from '../../src/main/conversation-move/relay'
import { ConversationMoveService } from '../../src/main/conversation-move/service'
import { getMove, listIncompleteMoves } from '../../src/main/conversation-move/store'
import type {
  ExportedPackage,
  MoveDigest,
  SourceInspection,
  TargetInspection,
} from '../../src/shared/conversation-move'
import { closeDb, freshDb, restartDb } from '../helpers/db'

const REMOTE = 'server-1/env-1'
const OTHER = 'server-1/env-2'
const HEAD = 'a'.repeat(40)
const TIP = 'b'.repeat(40)

const digest: MoveDigest = {
  conversationId: 'c1',
  messages: 3,
  lastSeq: 3,
  messagesSha256: 'c'.repeat(64),
  files: 1,
  filesSha256: 'd'.repeat(64),
  headOid: HEAD,
  indexTree: HEAD,
  worktreeTree: HEAD,
}
const pkg: ExportedPackage = {
  path: '/src/staging/c1.maestrly-move',
  name: 'c1.maestrly-move',
  size: 10,
  sha256: 'e'.repeat(64),
  digest,
}

const sourceInspection = (overrides: Partial<SourceInspection> = {}): SourceInspection => ({
  conversationId: 'c1',
  conversationName: 'Feature',
  cwd: '/repo/wt',
  mode: 'worktree',
  branch: 'feat',
  headOid: HEAD,
  remoteUrl: 'git@example.com:me/repo.git',
  defaultBranch: 'main',
  commitsAhead: 1,
  changes: { staged: [], unstaged: ['b.txt'], untracked: [] },
  ignored: [
    { path: '.env.local', size: 9, kind: 'file', sensitive: true, selectable: true },
    { path: 'dist', size: 9, kind: 'directory', sensitive: false, selectable: true },
    { path: '.git', size: 0, kind: 'directory', sensitive: false, selectable: false, reason: 'never' },
  ],
  transcript: { messages: 3, files: 1, fileBytes: 3 },
  fingerprint: 'f'.repeat(64),
  blockers: [],
  warnings: ['provider-session-restarts', 'runtime-not-moved', 'project-memory-stays'],
  ...overrides,
})

const targetInspection = (branch: Partial<TargetInspection['branch']> = {}): TargetInspection => ({
  workspace: {
    kind: 'clone',
    parentPath: '/projects',
    name: 'repo',
    remoteUrl: 'git@example.com:me/repo.git',
    defaultBranch: 'main',
  },
  branch: { name: 'feat', state: 'absent', ancestor: null, freeAlternative: 'feat-moved', ...branch },
  blockers: [],
})

let calls: string[]
let failing: Set<string>

type Methods = Exclude<keyof MoveEndpoint, 'hostId' | 'onProgress'>
type FakeEndpoint = MoveEndpoint & { [K in Methods]: Mock<MoveEndpoint[K]> }

function fakeEndpoint(hostId: string, role: 'source' | 'target'): FakeEndpoint {
  const step = <T>(name: string, value: T) =>
    vi.fn(async (..._args: unknown[]): Promise<T> => {
      calls.push(name)
      if (failing.has(name)) {
        failing.delete(name)
        throw new MoveError('host-unavailable', `${name} failed`)
      }
      return value
    })
  const endpoint = {
    hostId,
    inspectSource: step('inspectSource', sourceInspection()),
    checkAncestry: step('checkAncestry', false),
    inspectTarget: step('inspectTarget', targetInspection()),
    freezeSource: step('freezeSource', undefined),
    exportSource: step('exportSource', pkg),
    stagingDirectory: step('stagingDirectory', '/target/staging'),
    prepareTargetWorkspace: step('prepareTargetWorkspace', { workspaceId: 'ws-target' }),
    importTarget: step('importTarget', {
      conversationId: 'c1',
      workspaceId: 'ws-target',
      cwd: '/t/wt',
      branch: 'feat',
    }),
    verifyTarget: step('verifyTarget', digest),
    releaseSource: step('releaseSource', undefined),
    commitTarget: step('commitTarget', undefined),
    discardTarget: step('discardTarget', undefined),
    thawSource: step('thawSource', undefined),
    cleanup: step('cleanup', undefined),
    onProgress: vi.fn(() => () => {}),
  }
  void role
  return endpoint as unknown as FakeEndpoint
}

let endpoints: Record<string, FakeEndpoint>
let relay: ReturnType<typeof vi.fn> & PackageRelay
let now: number
let online: Set<string>

function service() {
  return new ConversationMoveService({
    endpoint: (hostId) => {
      const endpoint = endpoints[hostId]
      if (!endpoint) throw new MoveError('host-unavailable', 'unknown host')
      return endpoint
    },
    hostOnline: (hostId) => online.has(hostId),
    relay,
    localStagingDirectory: async () => '/local/staging',
    removeLocalStaging: vi.fn(async () => undefined),
    now: () => now,
  })
}

beforeEach(() => {
  freshDb()
  calls = []
  failing = new Set()
  now = 1_000_000
  online = new Set(['local', REMOTE, OTHER])
  endpoints = { local: fakeEndpoint('local', 'source'), [REMOTE]: fakeEndpoint(REMOTE, 'target') }
  relay = vi.fn(async (args: Parameters<PackageRelay>[0]) => {
    calls.push('relay')
    if (failing.has('relay')) {
      failing.delete('relay')
      throw new MoveError('transfer-failed', 'relay failed')
    }
    args.onProgress({ doneBytes: 10, size: 10 })
    return { path: '/target/staging/c1.maestrly-move', transferIds: ['t1'] }
  }) as unknown as ReturnType<typeof vi.fn> & PackageRelay
})
afterEach(closeDb)

const prepareLocalToRemote = (moves = service(), targetBranch?: string) =>
  moves.prepare({
    sourceHostId: 'local',
    conversationId: 'c1',
    targetHostId: REMOTE,
    ...(targetBranch ? { targetBranch } : {}),
  })

describe('conversation move service', () => {
  it('moves local → remote through every phase and completes', async () => {
    const moves = service()
    const phasesSeen: string[] = []
    const transfers: unknown[] = []
    moves.onChanged((event) => {
      if (phasesSeen.at(-1) !== event.phase) phasesSeen.push(event.phase)
      if (event.transfer) transfers.push(event.transfer)
    })
    const preview = await prepareLocalToRemote(moves)
    expect(preview).toMatchObject({
      blockers: [],
      target: { branch: 'feat', branchAction: 'create', workspace: { kind: 'clone' } },
    })
    expect(preview.warnings).toContain('clone-required')
    const result = await moves.execute({
      operationId: preview.operationId!,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    })
    expect(result).toMatchObject({ status: 'completed', target: { hostId: REMOTE, conversationId: 'c1' } })
    expect(calls).toEqual([
      'inspectSource',
      'inspectTarget',
      'freezeSource',
      'exportSource',
      'stagingDirectory',
      'relay',
      'prepareTargetWorkspace',
      'importTarget',
      'verifyTarget',
      'releaseSource',
      'commitTarget',
      'cleanup',
    ])
    expect(phasesSeen).toEqual([
      'prepared',
      'freezing',
      'exporting',
      'transferring',
      'preparing-target',
      'importing',
      'verifying',
      'releasing-source',
      'committing',
      'completed',
    ])
    expect(transfers).toEqual([{ doneBytes: 10, size: 10 }])
    expect(endpoints[REMOTE].importTarget).toHaveBeenCalledWith({
      operationId: preview.operationId,
      packagePath: '/target/staging/c1.maestrly-move',
      sha256: pkg.sha256,
      workspaceId: 'ws-target',
      plan: preview.target,
    })
    expect(endpoints.local.freezeSource).toHaveBeenCalledWith({
      operationId: preview.operationId,
      conversationId: 'c1',
      fingerprint: 'f'.repeat(64),
    })
    expect(listIncompleteMoves()).toEqual([])
  })

  it('returns a blocked preview without journaling', async () => {
    endpoints.local.inspectSource.mockResolvedValueOnce(
      sourceInspection({ blockers: [{ code: 'running', message: 'running' }] })
    )
    const preview = await prepareLocalToRemote()
    expect(preview.operationId).toBeNull()
    expect(preview.blockers.map((blocker) => blocker.code)).toEqual(['running'])
    expect(endpoints[REMOTE].inspectTarget).not.toHaveBeenCalled()
    expect(listIncompleteMoves()).toEqual([])
    expect(
      (await service().prepare({ sourceHostId: 'local', conversationId: 'c1', targetHostId: 'local' })).blockers
    ).toEqual([expect.objectContaining({ code: 'same-host' })])
    online.delete(REMOTE)
    expect((await prepareLocalToRemote()).blockers).toEqual([expect.objectContaining({ code: 'host-unavailable' })])
  })

  it('fast-forwards when the source knows the destination tip as an ancestor', async () => {
    endpoints[REMOTE].inspectTarget.mockResolvedValue(
      targetInspection({ state: 'exists', tipOid: TIP, ancestor: null })
    )
    endpoints.local.checkAncestry.mockResolvedValueOnce(true)
    const preview = await prepareLocalToRemote()
    expect(endpoints.local.checkAncestry).toHaveBeenCalledWith({ conversationId: 'c1', ancestorOid: TIP })
    expect(preview.target).toMatchObject({ branch: 'feat', branchAction: 'fast-forward', expectedTipOid: TIP })
    expect(preview.warnings).not.toContain('branch-renamed')
  })

  it('renames a diverged branch unless the person chose it', async () => {
    endpoints[REMOTE].inspectTarget.mockResolvedValue(
      targetInspection({ state: 'exists', tipOid: TIP, ancestor: false })
    )
    const implicit = await prepareLocalToRemote()
    expect(implicit.target).toMatchObject({ branch: 'feat-moved', branchAction: 'create' })
    expect(implicit.warnings).toContain('branch-renamed')
    await service().cancel(implicit.operationId!)
    const explicit = await prepareLocalToRemote(service(), 'feat')
    expect(explicit.operationId).toBeNull()
    expect(explicit.blockers.map((blocker) => blocker.code)).toEqual(['target-branch-unavailable'])
    expect(endpoints[REMOTE].inspectTarget).toHaveBeenLastCalledWith(expect.objectContaining({ branch: 'feat' }))
  })

  it('refuses an expired preview and an invalid ignored selection', async () => {
    const moves = service()
    const preview = await prepareLocalToRemote(moves)
    const id = preview.operationId!
    await expect(
      moves.execute({ operationId: id, selectedIgnoredPaths: ['.git'], confirmedSensitivePaths: [] })
    ).rejects.toThrow(/allowed selection/)
    await expect(
      moves.execute({ operationId: id, selectedIgnoredPaths: ['.env.local'], confirmedSensitivePaths: [] })
    ).rejects.toThrow(/confirmation/)
    now += 16 * 60_000
    await expect(
      moves.execute({ operationId: id, selectedIgnoredPaths: [], confirmedSensitivePaths: [] })
    ).rejects.toThrow(/expired/)
    expect(getMove(id)?.status).toBe('cancelled')
    // An expired preview no longer holds the conversation.
    expect((await prepareLocalToRemote(moves)).operationId).not.toBeNull()
  })

  it('carries the selection and confirmations to the export', async () => {
    const moves = service()
    const preview = await prepareLocalToRemote(moves)
    await moves.execute({
      operationId: preview.operationId!,
      selectedIgnoredPaths: ['.env.local', 'dist'],
      confirmedSensitivePaths: ['.env.local'],
    })
    expect(endpoints.local.exportSource).toHaveBeenCalledWith({
      operationId: preview.operationId,
      selectedIgnoredPaths: ['.env.local', 'dist'],
      confirmedSensitivePaths: ['.env.local'],
    })
  })

  it.each(['freezeSource', 'exportSource', 'relay', 'prepareTargetWorkspace', 'importTarget'])(
    'stops for recovery when %s fails and rolls back',
    async (step) => {
      const moves = service()
      const preview = await prepareLocalToRemote(moves)
      failing.add(step)
      const result = await moves.execute({
        operationId: preview.operationId!,
        selectedIgnoredPaths: [],
        confirmedSensitivePaths: [],
      })
      expect(result.status).toBe('recovery-required')
      expect(result.recovery).toMatchObject({ canRollback: true, canContinue: true })
      expect(moves.listRecoveries().map((recovery) => recovery.operationId)).toEqual([preview.operationId])
      expect((await moves.resolve(preview.operationId!, 'rollback')).status).toBe('rolled-back')
      expect(endpoints[REMOTE].discardTarget).toHaveBeenCalled()
      expect(endpoints.local.thawSource).toHaveBeenCalled()
      expect(endpoints.local.releaseSource).not.toHaveBeenCalled()
      expect(listIncompleteMoves()).toEqual([])
    }
  )

  it('treats a digest mismatch as recoverable before release', async () => {
    endpoints[REMOTE].verifyTarget.mockResolvedValueOnce({ ...digest, messages: 2 })
    const moves = service()
    const preview = await prepareLocalToRemote(moves)
    const result = await moves.execute({
      operationId: preview.operationId!,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    })
    expect(result.recovery).toMatchObject({ phase: 'verifying', errorCode: 'verification-failed', canRollback: true })
    expect(endpoints.local.releaseSource).not.toHaveBeenCalled()
    // The second check passes: the move goes on from verification.
    expect((await moves.resolve(preview.operationId!, 'continue')).status).toBe('completed')
    expect(endpoints.local.freezeSource).toHaveBeenCalledTimes(1)
  })

  it('only continues after the source was released', async () => {
    const moves = service()
    const preview = await prepareLocalToRemote(moves)
    failing.add('commitTarget')
    const result = await moves.execute({
      operationId: preview.operationId!,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    })
    expect(result.recovery).toMatchObject({ phase: 'committing', canRollback: false, canContinue: true })
    await expect(moves.resolve(preview.operationId!, 'rollback')).rejects.toThrow(/continue the move/)
    expect((await moves.resolve(preview.operationId!, 'continue')).status).toBe('completed')
    expect(endpoints.local.releaseSource).toHaveBeenCalledTimes(1)
  })

  it('resumes from the journal in a new service instance', async () => {
    const first = service()
    const preview = await prepareLocalToRemote(first)
    failing.add('importTarget')
    await first.execute({ operationId: preview.operationId!, selectedIgnoredPaths: [], confirmedSensitivePaths: [] })
    restartDb()
    const second = service()
    second.markInterrupted()
    expect(second.listRecoveries()).toEqual([expect.objectContaining({ phase: 'importing', canContinue: true })])
    expect((await second.resolve(preview.operationId!, 'continue')).status).toBe('completed')
    expect(endpoints.local.freezeSource).toHaveBeenCalledTimes(1)
    expect(endpoints.local.exportSource).toHaveBeenCalledTimes(1)
    expect(relay).toHaveBeenCalledTimes(1)
    expect(endpoints[REMOTE].importTarget).toHaveBeenCalledTimes(2)
  })

  it('marks a move interrupted mid-run for recovery and drops abandoned previews', async () => {
    const moves = service()
    const running = await prepareLocalToRemote(moves)
    // A crash between phases leaves the journal running.
    endpoints.local.exportSource.mockImplementationOnce(() => new Promise(() => {}))
    void moves.execute({ operationId: running.operationId!, selectedIgnoredPaths: [], confirmedSensitivePaths: [] })
    await vi.waitFor(() => expect(getMove(running.operationId!)?.phase).toBe('exporting'))
    endpoints[OTHER] = fakeEndpoint(OTHER, 'target')
    const abandoned = await service().prepare({ sourceHostId: REMOTE, conversationId: 'c2', targetHostId: OTHER })
    restartDb()
    service().markInterrupted()
    expect(getMove(running.operationId!)).toMatchObject({
      status: 'recovery-required',
      error: 'Interrupted; continue or roll back.',
    })
    expect(getMove(abandoned.operationId!)?.status).toBe('cancelled')
  })

  it('blocks a second move of the same conversation', async () => {
    await prepareLocalToRemote()
    const second = await prepareLocalToRemote()
    expect(second.operationId).toBeNull()
    expect(second.blockers.map((blocker) => blocker.code)).toEqual(['incomplete-operation'])
  })

  it('relays remote → local and remote → remote', async () => {
    endpoints = {
      local: fakeEndpoint('local', 'target'),
      [REMOTE]: fakeEndpoint(REMOTE, 'source'),
      [OTHER]: fakeEndpoint(OTHER, 'target'),
    }
    const moves = service()
    const back = await moves.prepare({ sourceHostId: REMOTE, conversationId: 'c1', targetHostId: 'local' })
    expect(
      (await moves.execute({ operationId: back.operationId!, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }))
        .status
    ).toBe('completed')
    expect(relay).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: REMOTE, to: 'local', targetDirectory: null, localDirectory: '/local/staging' })
    )
    expect(endpoints.local.stagingDirectory).not.toHaveBeenCalled()

    const across = await moves.prepare({ sourceHostId: REMOTE, conversationId: 'c3', targetHostId: OTHER })
    expect(
      (await moves.execute({ operationId: across.operationId!, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }))
        .status
    ).toBe('completed')
    expect(relay).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: REMOTE, to: OTHER, targetDirectory: '/target/staging' })
    )
  })
})
