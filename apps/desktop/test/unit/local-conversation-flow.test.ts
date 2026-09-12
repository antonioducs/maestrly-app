import { describe, expect, it } from 'vitest'
import type { LocalConversationPreview } from '../../src/shared/local-conversation'
import {
  initialLocalConversationFlow,
  localConversationFlowReducer,
} from '../../src/renderer/components/local-conversation/flow'

const preview: LocalConversationPreview = {
  currentBranch: 'main',
  headOid: 'a'.repeat(40),
  targetBranch: 'feature/x',
  targetOid: 'b'.repeat(40),
  targetLabel: 'refs/heads/other',
  strategy: 'stash-switch-apply',
  changes: { staged: ['a'], unstaged: ['b'], untracked: ['c'] },
  ignoredCollisions: [],
  blockers: [],
  activity: [],
  dirty: true,
  requiresConfirmation: true,
}

describe('local conversation flow', () => {
  it('a dirty tree stops at preview and advances only after confirmation', () => {
    const ready = localConversationFlowReducer(initialLocalConversationFlow, {
      type: 'preview',
      token: 't',
      preview,
    })
    expect(ready.step).toBe('preview')
    expect(localConversationFlowReducer(ready, { type: 'confirm' }).step).toBe('confirming')
  })

  it('stale replaces the preview and recovery or blocked never becomes created', () => {
    const stale = localConversationFlowReducer(
      { step: 'preparing' },
      {
        type: 'preview',
        token: 'new',
        preview,
        message: 'stale',
      }
    )
    expect(stale).toMatchObject({ step: 'preview', token: 'new', message: 'stale' })
    expect(
      localConversationFlowReducer(stale, {
        type: 'blocked',
        preview,
        blockers: [{ code: 'activity', message: 'busy' }],
      }).step
    ).toBe('blocked')
    expect(
      localConversationFlowReducer(stale, {
        type: 'recovery',
        preview,
        recovery: { currentBranch: 'other', headOid: 'b', status: [], commands: [], message: 'resolve' },
      }).step
    ).toBe('recovery')
  })

  it('only a created event produces created state', () => {
    expect(localConversationFlowReducer({ step: 'preparing' }, { type: 'created' }).step).toBe('created')
  })
})
