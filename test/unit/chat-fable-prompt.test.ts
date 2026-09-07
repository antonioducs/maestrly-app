import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { compileFableCompactionSystem, compileFableSubagentPrompt } from '../../src/main/chat/fable/prompt'
import { FABLE_51_BEHAVIOR_PROFILE } from '../../src/main/chat/fable/profile'
import { SYSTEM_PROMPT } from '../../src/main/chat/runner'

const LEGACY_PROMPT_HASHES = {
  'agent:false:false': '1b47682777a17ed9b027d8f62e1d66966981891a92bb766d5dc0cb836a607912',
  'agent:false:true': 'c757174223f0e8f1bf24585007c08970b2fa92bfaec8e35f9607531122bcd087',
  'agent:true:false': '9387db0f9a7638a6910378637efbccab493605d3f2cc107f115b070e6ba130e6',
  'agent:true:true': '530e8d7b25fdc9eaebd9408f9373d746403bc2391ec6fef5638e5d2b2ec898d3',
  'ask:false:false': '0fc777ea3a4336b9334b2fb57ef4fdb07a66de507a7f09c7c664e715c62c9b4d',
  'ask:false:true': 'b9422757547bc897cc51da5195490e1e6a42cc288cfe60f7944b7674b2e52f94',
  'ask:true:false': '1f62e7655787684ac35bc96f0f4e9ebd3b31e8af3784ac644e50c9f33c1da238',
  'ask:true:true': 'cbb8b070be865ad9407dee4e76eb93b442dc0be99d4f6fb22b1518c1b611120d',
  'plan:false:false': '4e4a8d927390cb2ebe91ffc95142aabda967b2fad0f3148d7dd35d08d450ae8c',
  'plan:false:true': '4b4588c424fedbf254a02bef994c44d7172730af721fe91c032a80c6b53add18',
  'plan:true:false': '3afcd159db5e7a4f3c997a8660449d5a1ddc7f4a7b95b1be81f174c4e70e70a3',
  'plan:true:true': 'd7c90d4956ca439fc8aefb509b097bdf9b3ab751bfdb44797e3da7da7da8b056',
  'maestro:false:false': '8acee4eff1a21953eee8c1eef1052353359d1be3156e4ada2acf918e42f1b435',
  'maestro:false:true': 'c0305c958ced6bb267699b56d7fc3ec614e2eea4293526b37a381f445572d353',
  'maestro:true:false': 'd4f30d87147b0c8c5491cfdd090676e9eda84aeea61f77cf63071a11bfa8231a',
  'maestro:true:true': '80c0bbe4c6a81cdc424c4d89787b2a617008724b3bd81d5fd0365832c9548a1b',
}

describe('Fable 5.1 prompt fragments', () => {
  it('captures legacy prompt hashes', () => {
    const hashes: Record<string, string> = {}
    for (const mode of ['agent', 'ask', 'plan', 'maestro'] as const) {
      for (const appToolsEnabled of [false, true]) {
        for (const hasNotesTab of [false, true]) {
          const key = `${mode}:${appToolsEnabled}:${hasNotesTab}`
          hashes[key] = createHash('sha256')
            .update(SYSTEM_PROMPT('/repo', appToolsEnabled, mode, hasNotesTab))
            .digest('hex')
        }
      }
    }
    expect(hashes).toEqual(LEGACY_PROMPT_HASHES)
  })
  it('preserves legacy prompt bytes when the profile is absent', () => {
    const legacy = 'legacy\n\nprompt'
    expect(compileFableSubagentPrompt(legacy, null)).toBe(legacy)
    expect(compileFableCompactionSystem(legacy, null)).toBe(legacy)
    for (const mode of ['agent', 'ask', 'plan', 'maestro'] as const) {
      for (const appToolsEnabled of [false, true]) {
        expect(SYSTEM_PROMPT('/repo', appToolsEnabled, mode, false, null)).toBe(
          SYSTEM_PROMPT('/repo', appToolsEnabled, mode, false)
        )
      }
    }
  })

  it('replaces conflicting legacy style while preserving mode capability barriers', () => {
    const agent = SYSTEM_PROMPT('/repo', true, 'agent', false, FABLE_51_BEHAVIOR_PROFILE)
    expect(agent).toContain('brief progress updates at meaningful milestones')
    expect(agent).toContain('complete closing summary')
    expect(agent).not.toContain("don't pad with caveats, recaps or repetition")
    expect(agent).not.toContain("don't restate the question or narrate routine steps")

    const ask = SYSTEM_PROMPT('/repo', true, 'ask', false, FABLE_51_BEHAVIOR_PROFILE)
    expect(ask).toContain('ASK MODE (restricted tools)')
    expect(ask).toContain('Do NOT edit project files or run commands')
    const plan = SYSTEM_PROMPT('/repo', true, 'plan', false, FABLE_51_BEHAVIOR_PROFILE)
    expect(plan).toContain('Calling review_plan ENDS your turn')
    const maestro = SYSTEM_PROMPT('/repo', true, 'maestro', false, FABLE_51_BEHAVIOR_PROFILE)
    expect(maestro).toContain('parent is structurally read-only')
  })

  it('gives children role-appropriate instructions without user-facing progress', () => {
    const prompt = compileFableSubagentPrompt('Base child contract.', FABLE_51_BEHAVIOR_PROFILE)
    expect(prompt).toContain('maestrly-fable-5.1-v1')
    expect(prompt).toContain('report to the parent')
    expect(prompt).toContain('Do not address the user')
    expect(prompt).not.toContain('report progress to the user')
  })

  it('preserves decisions, rejected attempts, exact references and truthful checks in summaries', () => {
    const prompt = compileFableCompactionSystem('Legacy compact.', FABLE_51_BEHAVIOR_PROFILE)
    expect(prompt).toContain('rejected attempts')
    expect(prompt).toContain('user constraints and decisions')
    expect(prompt).toContain('exact references')
    expect(prompt).toContain('Never invent')
  })
})
