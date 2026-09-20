/**
 * Cancellation reaches the real work.
 *
 * A stage that is cancelled must stop its local turn, report a receipt that says so, and release the review
 * copy. An attempt already recorded on this computer is never executed twice after a reconnection.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import {
  admitDelegationAttempt,
  delegationAttemptFor,
  finishDelegationAttempt,
  pendingDelegationReceipts,
  recordDelegationReceipt,
} from '../../src/main/platform/project-chat-store'
import { buildStageReceipt } from '../../src/main/platform/delegation-receipt'

beforeEach(freshDb)
afterEach(closeDb)

const settings = {
  selectionId: 'sel-opus',
  reasoning: 'high',
  fastMode: false,
  executionMode: 'standard' as const,
  delegationProfiles: [],
}

it('records a cancelled stage with its blocker instead of reporting success', () => {
  const receipt = buildStageReceipt({
    requested: settings,
    admitted: settings,
    observed: {
      selectionId: 'sel-opus',
      modelId: 'claude-opus-5',
      accountLabel: 'Claude · personal',
      reasoning: 'high',
      fastMode: false,
      harnessProfileId: null,
      harnessHash: null,
    },
    conversationId: 'conversation',
    result: 'cancelled',
    summary: 'Stopped on request',
    blocker: 'Stopped on request',
    durationMs: 1200,
  })
  expect(receipt.result).toBe('cancelled')
  expect(receipt.blocker).toBe('Stopped on request')
  expect(receipt.selectionHonored).toBe(true)
  expect(receipt.durationMs).toBe(1200)
})

it('refuses to run the same attempt twice after a reconnection', () => {
  const admit = (attemptId: string, turnId: string) =>
    admitDelegationAttempt({
      instanceId: 'instance',
      attemptId,
      taskId: 'task-1',
      stageId: 'stage-1',
      turnId,
      leaseId: 'lease-1',
    })
  expect(admit('attempt-1', 'turn-1')).toBe(true)
  // A second claim of the same attempt is refused, so the work is not repeated.
  expect(admit('attempt-1', 'turn-1')).toBe(false)
  // The journal identifies the attempt by turn, not by a reused process identifier.
  expect(delegationAttemptFor('turn-1')?.attempt_id).toBe('attempt-1')
  expect(delegationAttemptFor('turn-unknown')).toBeNull()
  // A genuinely new attempt for the same stage is admitted.
  expect(admit('attempt-2', 'turn-2')).toBe(true)
})

it('keeps a recorded receipt until the server acknowledges it', () => {
  admitDelegationAttempt({
    instanceId: 'instance',
    attemptId: 'attempt-1',
    taskId: 'task-1',
    stageId: 'stage-1',
    turnId: 'turn-1',
    leaseId: 'lease-1',
  })
  const receipt = buildStageReceipt({
    requested: settings,
    admitted: settings,
    observed: null,
    conversationId: null,
    result: 'interrupted',
    summary: 'Desktop stopped mid-stage',
  })
  // No observed identity means the selection cannot be claimed as honored.
  expect(receipt.selectionHonored).toBe(false)
  recordDelegationReceipt('attempt-1', receipt)
  expect(pendingDelegationReceipts('instance')).toHaveLength(1)
  expect(pendingDelegationReceipts('other-instance')).toHaveLength(0)
  finishDelegationAttempt('attempt-1')
  expect(pendingDelegationReceipts('instance')).toHaveLength(0)
})
