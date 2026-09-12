import { describe, expect, it } from 'vitest'
import type { Conversation, MigrationPreview } from '../../src/preload'
import {
  canExecuteConversationMigration,
  conversationMigrationDialogReducer,
  findConversation,
  initialConversationMigrationDialog,
  isApparentlyMigrationEligible,
  missingSensitiveConfirmations,
} from '../../src/renderer/components/conversation-migration/flow'

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation',
    workspaceId: 'workspace',
    name: 'Conversation',
    branch: 'main',
    mode: 'local',
    experience: 'standard',
    cwd: '/repo',
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
    isMulti: 0,
    ...patch,
  }
}

function preview(patch: Partial<MigrationPreview> = {}): MigrationPreview {
  return {
    operationId: 'operation',
    conversationId: 'conversation',
    sourceBranch: 'main',
    sourceHeadOid: 'a'.repeat(40),
    sourceCwd: '/repo',
    destinationBranch: 'feature/x',
    destinationCwd: '/worktree',
    changes: { staged: ['staged.ts'], unstaged: ['dirty.ts'], untracked: ['new.ts'] },
    ignored: [
      { path: 'cache', size: 5, kind: 'directory', sensitive: false, selectable: true },
      { path: '.env', size: 10, kind: 'file', sensitive: true, selectable: true },
      { path: '.git', size: 0, kind: 'directory', sensitive: false, selectable: false, reasonCode: 'reserved' },
    ],
    blockers: [],
    expiresAt: 10_000,
    ...patch,
  }
}

describe('conversation migration renderer flow', () => {
  it('shows the action only for an active single-repository local conversation', () => {
    expect(isApparentlyMigrationEligible(conversation())).toBe(true)
    expect(isApparentlyMigrationEligible(conversation({ mode: 'worktree' }))).toBe(false)
    expect(isApparentlyMigrationEligible(conversation({ isMulti: 1 }))).toBe(false)
    expect(isApparentlyMigrationEligible(conversation({ archived: 1 }))).toBe(false)
  })

  it('resets selection when opening or receiving a preview and ignores events from another operation', () => {
    let state = conversationMigrationDialogReducer(initialConversationMigrationDialog, {
      type: 'open',
      conversation: conversation(),
    })
    state = conversationMigrationDialogReducer(state, { type: 'branch', value: 'feature/x' })
    state = conversationMigrationDialogReducer(state, { type: 'prepare-start' })
    state = conversationMigrationDialogReducer(state, { type: 'prepare-success', preview: preview() })
    expect(state).toMatchObject({
      open: true,
      destinationBranch: 'feature/x',
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
      busy: null,
    })

    const unchanged = conversationMigrationDialogReducer(state, {
      type: 'progress',
      event: {
        operationId: 'other',
        phase: 'completed',
        status: 'completed',
        conversationId: 'conversation',
      },
    })
    expect(unchanged).toBe(state)
  })

  it('sensitive ignored files require confirmation, cleared on deselection', () => {
    let state = conversationMigrationDialogReducer(
      conversationMigrationDialogReducer(initialConversationMigrationDialog, {
        type: 'open',
        conversation: conversation(),
      }),
      { type: 'prepare-success', preview: preview() }
    )
    state = conversationMigrationDialogReducer(state, {
      type: 'toggle-ignored',
      path: '.env',
      selected: true,
      sensitive: true,
    })
    expect(missingSensitiveConfirmations(preview(), state.selectedIgnoredPaths, state.confirmedSensitivePaths)).toEqual(
      ['.env']
    )
    expect(canExecuteConversationMigration(state, 1)).toBe(false)

    state = conversationMigrationDialogReducer(state, {
      type: 'confirm-sensitive',
      path: '.env',
      confirmed: true,
    })
    expect(canExecuteConversationMigration(state, 1)).toBe(true)

    state = conversationMigrationDialogReducer(state, {
      type: 'toggle-ignored',
      path: '.env',
      selected: false,
      sensitive: true,
    })
    expect(state.confirmedSensitivePaths).toEqual([])
    expect(canExecuteConversationMigration(state, 1)).toBe(true)
  })

  it('blockers, expiration, and busy state prevent execution', () => {
    const base = conversationMigrationDialogReducer(
      conversationMigrationDialogReducer(initialConversationMigrationDialog, {
        type: 'open',
        conversation: conversation(),
      }),
      { type: 'prepare-success', preview: preview() }
    )
    expect(canExecuteConversationMigration(base, 1)).toBe(true)
    expect(canExecuteConversationMigration(base, 10_001)).toBe(false)
    expect(canExecuteConversationMigration({ ...base, busy: 'executing' }, 1)).toBe(false)
    expect(
      canExecuteConversationMigration(
        {
          ...base,
          preview: preview({ blockers: [{ code: 'git-operation', message: 'blocked' }] }),
        },
        1
      )
    ).toBe(false)
  })

  it('edit-branch returns to the branch step, preserving text and allowing further edits', () => {
    let state = conversationMigrationDialogReducer(initialConversationMigrationDialog, {
      type: 'open',
      conversation: conversation(),
    })
    state = conversationMigrationDialogReducer(state, { type: 'branch', value: 'feat/testing' })
    state = conversationMigrationDialogReducer(state, {
      type: 'prepare-success',
      preview: preview({
        destinationBranch: 'feat/testing',
        blockers: [{ code: 'branch-exists', message: 'Branch feat/testing already exists.' }],
      }),
    })
    // While a preview is active, branch edits are ignored because the prepared operation freezes state.
    expect(conversationMigrationDialogReducer(state, { type: 'branch', value: 'feat/other' })).toBe(state)

    state = conversationMigrationDialogReducer(state, { type: 'cancel-start' })
    state = conversationMigrationDialogReducer(state, { type: 'edit-branch' })
    expect(state).toMatchObject({
      open: true,
      preview: null,
      destinationBranch: 'feat/testing',
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
      busy: null,
      progress: null,
      error: null,
    })

    state = conversationMigrationDialogReducer(state, { type: 'branch', value: 'feat/testing-2' })
    expect(state.destinationBranch).toBe('feat/testing-2')
  })

  it('finds the conversation in the snapshot returned by refresh', () => {
    const target = conversation({ id: 'successor', cwd: '/worktree', mode: 'worktree' })
    expect(findConversation([{ conversations: [conversation()] }, { conversations: [target] }], 'successor')).toBe(
      target
    )
    expect(findConversation([{ conversations: [conversation()] }], 'missing')).toBeNull()
  })
})
