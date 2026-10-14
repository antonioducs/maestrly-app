import { describe, expect, it } from 'vitest'
import type { Conversation } from '../../src/preload'
import {
  canExecuteMove,
  initialMoveFlow,
  isApparentlyMoveEligible,
  missingMoveConfirmations,
  moveFlowReducer,
  type MoveFlowState,
  moveTargetConversationKey,
  moveTargetsFor,
} from '../../src/renderer/lib/conversation-move/flow'
import type { MoveChangedEvent, MovePreview } from '../../src/shared/conversation-move'
import type { HostView } from '../../src/shared/hosts'

const REMOTE = 'server-1/env-1'
const OTHER = 'server-1/env-2'
const OP = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const NOW = 1_000_000

const conversation = (overrides: Partial<Conversation> = {}): Conversation =>
  ({
    scope: 'project',
    id: 'c1',
    workspaceId: 'ws',
    name: 'Feature',
    branch: 'feat',
    mode: 'worktree',
    experience: 'standard',
    cwd: '/repo',
    status: 'idle',
    createdAt: 0,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 0,
    isMulti: 0,
    ...overrides,
  }) as Conversation

const host = (id: string, overrides: Partial<HostView> = {}): HostView =>
  ({
    id,
    remote: id !== 'local',
    label: id === 'local' ? '' : `label-${id}`,
    state: 'online',
    epoch: 1,
    os: 'linux',
    homeDir: '/home',
    desktopEffects: false,
    editor: true,
    browser: true,
    environment: null,
    hostVersion: null,
    ...overrides,
  }) as HostView

const preview = (overrides: Partial<MovePreview> = {}): MovePreview => ({
  operationId: OP,
  expiresAt: NOW + 60_000,
  conversationId: 'c1',
  conversationName: 'Feature',
  sourceHostId: 'local',
  targetHostId: REMOTE,
  source: {
    cwd: '/repo',
    branch: 'feat',
    headOid: 'a'.repeat(40),
    mode: 'worktree',
    commitsAhead: 1,
    changes: { staged: [], unstaged: [], untracked: [] },
  },
  target: {
    workspace: { kind: 'clone', parentPath: '/p', name: 'repo', remoteUrl: 'u', defaultBranch: 'main' },
    branch: 'feat',
    branchAction: 'create',
  },
  ignored: [
    { path: '.env.local', size: 1, kind: 'file', sensitive: true, selectable: true },
    { path: 'dist', size: 1, kind: 'directory', sensitive: false, selectable: true },
  ],
  transcript: { messages: 2, files: 0, fileBytes: 0 },
  warnings: [],
  blockers: [],
  fingerprint: 'f'.repeat(64),
  ...overrides,
})

const event = (overrides: Partial<MoveChangedEvent> = {}): MoveChangedEvent => ({
  operationId: OP,
  conversationId: 'c1',
  sourceHostId: 'local',
  targetHostId: REMOTE,
  phase: 'transferring',
  status: 'running',
  ...overrides,
})

function previewed(value = preview()): MoveFlowState {
  const preparing = moveFlowReducer(initialMoveFlow, {
    type: 'prepare',
    sourceHostId: 'local',
    conversationId: 'c1',
    targetHostId: REMOTE,
    conversationName: 'Feature',
  })
  return moveFlowReducer(preparing, { type: 'prepared', preview: value })
}

describe('conversation move renderer flow', () => {
  it('offers move only for single-repository project conversations', () => {
    expect(isApparentlyMoveEligible(conversation())).toBe(true)
    expect(isApparentlyMoveEligible(conversation({ scope: 'standalone' } as Partial<Conversation>))).toBe(false)
    expect(isApparentlyMoveEligible(conversation({ isMulti: 1 }))).toBe(false)
    expect(isApparentlyMoveEligible(conversation({ archived: 1 }))).toBe(false)
    expect(isApparentlyMoveEligible(conversation({ botOrigin: {} } as Partial<Conversation>))).toBe(false)
  })

  it("lists online hosts other than the conversation's own", () => {
    const hosts = [host('local'), host(REMOTE), host(OTHER), host('server-2/env-9', { state: 'offline' })]
    expect(moveTargetsFor('c1', hosts)).toEqual([
      { hostId: REMOTE, label: `label-${REMOTE}` },
      { hostId: OTHER, label: `label-${OTHER}` },
    ])
    expect(moveTargetsFor(`${REMOTE}#c1`, hosts)).toEqual([
      { hostId: 'local', label: null },
      { hostId: OTHER, label: `label-${OTHER}` },
    ])
    expect(moveTargetsFor('c1', [host('local')])).toEqual([])
  })

  it('walks preview → executing → done and ignores other operations', () => {
    let state = previewed()
    expect(state).toMatchObject({ kind: 'preview', branchDraft: 'feat', selected: [], confirmed: [] })
    expect(canExecuteMove(state, NOW)).toBe(true)
    state = moveFlowReducer(state, { type: 'execute' })
    expect(state).toMatchObject({ kind: 'executing', event: null })
    state = moveFlowReducer(state, { type: 'progress', event: event({ operationId: 'other' }) })
    expect(state).toMatchObject({ kind: 'executing', event: null })
    state = moveFlowReducer(state, { type: 'progress', event: event({ transfer: { doneBytes: 1, size: 2 } }) })
    expect(state).toMatchObject({ kind: 'executing', event: { phase: 'transferring', transfer: { doneBytes: 1 } } })
    state = moveFlowReducer(state, {
      type: 'finished',
      result: { operationId: OP, status: 'completed', target: { hostId: REMOTE, conversationId: 'c1' } },
    })
    expect(state).toMatchObject({ kind: 'done', result: { status: 'completed' } })
    expect(moveFlowReducer(state, { type: 'close' })).toEqual(initialMoveFlow)
  })

  it('keeps a stopped move in the dialog with its recovery', () => {
    let state = moveFlowReducer(previewed(), { type: 'execute' })
    state = moveFlowReducer(state, {
      type: 'finished',
      result: {
        operationId: OP,
        status: 'recovery-required',
        recovery: {
          operationId: OP,
          conversationId: 'c1',
          conversationName: 'Feature',
          sourceHostId: 'local',
          targetHostId: REMOTE,
          phase: 'importing',
          status: 'recovery-required',
          canContinue: true,
          canRollback: true,
          message: 'boom',
          errorCode: 'package-invalid',
        },
      },
    })
    expect(state).toMatchObject({ kind: 'error', message: 'boom', recovery: { phase: 'importing' } })
    // Continuing runs it again.
    expect(moveFlowReducer(state, { type: 'execute' })).toMatchObject({ kind: 'executing' })
  })

  it('requires confirming sensitive entries before execute', () => {
    let state = previewed()
    state = moveFlowReducer(state, { type: 'toggle-ignored', path: '.env.local' })
    state = moveFlowReducer(state, { type: 'toggle-ignored', path: 'dist' })
    expect(canExecuteMove(state, NOW)).toBe(false)
    expect(
      state.kind === 'preview' && missingMoveConfirmations(state.preview, state.selected, state.confirmed)
    ).toEqual(['.env.local'])
    state = moveFlowReducer(state, { type: 'confirm-sensitive', path: '.env.local' })
    expect(canExecuteMove(state, NOW)).toBe(true)
    // Unselecting drops its confirmation.
    state = moveFlowReducer(state, { type: 'toggle-ignored', path: '.env.local' })
    expect(state).toMatchObject({ selected: ['dist'], confirmed: [] })
  })

  it('refuses to execute a blocked, expired or edited preview', () => {
    expect(
      canExecuteMove(previewed(preview({ operationId: null, blockers: [{ code: 'running', message: 'x' }] })), NOW)
    ).toBe(false)
    expect(canExecuteMove(previewed(), NOW + 120_000)).toBe(false)
    const edited = moveFlowReducer(previewed(), { type: 'edit-branch', value: 'other' })
    expect(canExecuteMove(edited, NOW)).toBe(false)
  })

  it('builds the focus key of the moved conversation', () => {
    expect(moveTargetConversationKey('local', 'c1')).toBe('c1')
    expect(moveTargetConversationKey(REMOTE, 'c1')).toBe(`${REMOTE}#c1`)
  })
})
