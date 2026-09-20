import { describe, expect, it } from 'vitest'
import {
  assertAcyclicStageInputs,
  builtInDelegationPresets,
  defaultDelegationPolicy,
  delegationCommandSchema,
  delegationCreateSchema,
  delegationPolicyPatchSchema,
  isAgentStageType,
  mergeDelegationPolicy,
  stageDefinitionInputSchema,
  stageDefinitionSchema,
  stageExecutionReceiptSchema,
} from '../src/index.js'

describe('delegation contracts', () => {
  it('requires agent settings on agent stages and a host action on host stages', () => {
    const agent = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'implement',
      title: 'Implement',
      instructions: '',
      position: 0,
      dependsOn: [],
      settings: { selectionId: 'sel', reasoning: null, fastMode: false, executionMode: 'standard', delegationProfiles: [] },
      action: null,
      requiredForCompletion: true,
      state: 'pending',
      attempts: 0,
      settingsRevision: 1,
      version: 1,
    }
    expect(stageDefinitionSchema.parse(agent).type).toBe('implement')
    expect(() => stageDefinitionSchema.parse({ ...agent, settings: null })).toThrowError()
    expect(() =>
      stageDefinitionSchema.parse({ ...agent, type: 'verify', settings: null, action: null })
    ).toThrowError()
    expect(
      stageDefinitionSchema.parse({
        ...agent,
        type: 'verify',
        settings: null,
        action: { kind: 'checks', checkIds: ['unit'] },
      }).action
    ).toEqual({ kind: 'checks', checkIds: ['unit'] })
    expect(isAgentStageType('review')).toBe(true)
    expect(isAgentStageType('deliver')).toBe(false)
  })

  it('merges a policy patch without resetting unrelated capabilities or limits', () => {
    const base = defaultDelegationPolicy()
    expect(base.autonomy.push).toBe(false)
    expect(base.completionTarget).toBe('patch_ready')
    const patched = mergeDelegationPolicy(
      base,
      delegationPolicyPatchSchema.parse({ autonomy: { push: true }, limits: { maxFixAttempts: 5 }, completionTarget: 'pr_ready' })
    )
    expect(patched.autonomy).toMatchObject({ push: true, edit: true, merge: false })
    expect(patched.limits.maxFixAttempts).toBe(5)
    expect(patched.limits.maxActiveSeconds).toBe(base.limits.maxActiveSeconds)
    expect(patched.completionTarget).toBe('pr_ready')
    // Unknown budgets stay unknown instead of being presented as measured values.
    expect(patched.limits.maxTokens).toBeNull()
    expect(patched.limits.maxCostUsd).toBeNull()
  })

  it('rejects a stage dependency cycle before anything is persisted', () => {
    const stage = (title: string, dependsOn: number[]) =>
      stageDefinitionInputSchema.parse({ type: 'implement', title, dependsOn })
    expect(() => assertAcyclicStageInputs([stage('a', []), stage('b', [0])])).not.toThrow()
    expect(() => assertAcyclicStageInputs([stage('a', [0])])).toThrowError(/cannot depend on itself/)
    expect(() => assertAcyclicStageInputs([stage('a', [1]), stage('b', [])])).toThrowError(/earlier stage/)
  })

  it('requires either an existing card or a board and title when creating a task', () => {
    const shared = {
      executorId: '22222222-2222-4222-8222-222222222222',
      workspaceKey: 'workspace',
      baseBranch: 'main',
      stages: [{ type: 'implement', title: 'Implement' }],
    }
    expect(() => delegationCreateSchema.parse(shared)).toThrowError(/existing cardId/)
    expect(
      delegationCreateSchema.parse({ ...shared, boardId: '33333333-3333-4333-8333-333333333333', title: 'New card' })
        .stages[0]!.type
    ).toBe('implement')
    expect(delegationCreateSchema.parse({ ...shared, cardId: '44444444-4444-4444-8444-444444444444' }).start).toBe(false)
  })

  it('keeps every command version-checked and every configure target explicit', () => {
    expect(() => delegationCommandSchema.parse({ type: 'start' })).toThrowError()
    const configure = delegationCommandSchema.parse({
      type: 'configure',
      expectedVersion: 3,
      target: 'stage',
      stageId: '55555555-5555-4555-8555-555555555555',
      settingsPatch: { selectionId: 'sel-astra', fastMode: 'if-available' },
    })
    expect(configure).toMatchObject({ apply: 'after_current' })
    expect(
      delegationCommandSchema.parse({ type: 'deliver', expectedVersion: 1, mode: 'ready_pr' })
    ).toMatchObject({ mode: 'ready_pr', expectedCodeRevision: null })
    expect(() => delegationCommandSchema.parse({ type: 'deliver', expectedVersion: 1, mode: 'rebase' })).toThrowError()
  })

  it('records requested, admitted and observed selections separately in a receipt', () => {
    const settings = {
      selectionId: 'sel-opus',
      reasoning: 'high',
      fastMode: false,
      executionMode: 'standard' as const,
      delegationProfiles: [],
    }
    const receipt = stageExecutionReceiptSchema.parse({
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
      selectionHonored: true,
      conversationId: 'conversation',
      result: 'succeeded',
    })
    expect(receipt.tokensObserved).toBe(false)
    expect(receipt.tokens).toBeNull()
    const mismatch = stageExecutionReceiptSchema.parse({ ...receipt, selectionHonored: false })
    expect(mismatch.selectionHonored).toBe(false)
  })

  it('ships versioned built-in presets whose stages are valid pipelines', () => {
    const presets = builtInDelegationPresets()
    expect(presets.map((preset) => preset.name)).toEqual([
      'Implement and review',
      'Review an existing pull request',
      'Reproduce and fix a bug',
      'Follow a pull request',
    ])
    for (const preset of presets) {
      expect(preset.builtIn).toBe(true)
      expect(preset.version).toBe(1)
      expect(() => assertAcyclicStageInputs(preset.stages)).not.toThrow()
      for (const stage of preset.stages)
        expect(isAgentStageType(stage.type) ? !stage.action : !!stage.action).toBe(true)
    }
    const prReview = presets[1]!
    expect(prReview.policy.autonomy.edit).toBe(false)
    expect(prReview.policy.completionTarget).toBe('pr_ready')
  })
})
