import { describe, expect, it } from 'vitest'
import {
  conversationDispatchBatchSchema,
  conversationDispatchFingerprintInput,
  parseConversationDispatchBatchResult,
} from '../../src/shared/conversation-dispatch'
const task = { requestKey: 'A', title: 'Task', prompt: 'Implement it' }
describe('conversation dispatch destination schema', () => {
  it('accepts targets and preserves exact names', () => {
    expect(
      conversationDispatchBatchSchema.parse({
        target: { workspaceId: 'repo', baseBranch: 'main' },
        tasks: [{ ...task, target: { branch: 'Feature/Exact' } }],
      }).tasks[0].target?.branch
    ).toBe('Feature/Exact')
  })
  it('rejects unknown fields and effective shared targets', () => {
    expect(
      conversationDispatchBatchSchema.safeParse({ tasks: [{ ...task, target: { path: '/tmp/repo' } }] }).success
    ).toBe(false)
    expect(
      conversationDispatchBatchSchema.safeParse({
        target: { workspaceId: 'repo' },
        tasks: [{ ...task, placement: 'shared' }],
      }).success
    ).toBe(false)
    expect(
      conversationDispatchBatchSchema.safeParse({
        placement: 'shared',
        tasks: [{ ...task, target: { baseBranch: 'main' } }],
      }).success
    ).toBe(false)
  })
  it('preserves legacy fingerprints and fingerprints each target field', () => {
    const input = { title: 'Task', prompt: 'Implement it', placement: 'worktree' as const, settings: {} }
    const legacy = '["Task","Implement it","worktree",null,null,null,null,null,null]'
    expect(conversationDispatchFingerprintInput(input)).toBe(legacy)
    expect(conversationDispatchFingerprintInput({ ...input, target: {} })).toBe(legacy)
    for (const target of [{ workspaceId: 'repo' }, { branch: 'feature' }, { baseBranch: 'main' }])
      expect(conversationDispatchFingerprintInput({ ...input, target })).not.toBe(legacy)
  })
  it('retains destination provenance in result parsing', () => {
    expect(
      parseConversationDispatchBatchResult(
        JSON.stringify({
          ok: true,
          items: [
            { requestKey: 'A', title: 'Task', status: 'started', workspaceId: 'repo', baseRevision: 'a'.repeat(40) },
          ],
        })
      )?.items[0]
    ).toMatchObject({ workspaceId: 'repo', baseRevision: 'a'.repeat(40) })
  })
})
