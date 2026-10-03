import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { harnessFor } from '../../src/main/chat/harness/execution'
import {
  buildMaestrlyBasePrompt,
  harnessCompactionSystem,
  harnessSubagentPrompt,
} from '../../src/main/chat/harness/host-contracts'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

const generic = harnessFor('anthropic', 'generic-model')
const fable = harnessFor('claude-subscription', 'claude-fable-5-1')

const prompt = (appToolsEnabled: boolean, mode: ChatBehavior, hasNotesTab: boolean, harness = generic): string =>
  buildMaestrlyBasePrompt({ harness, cwd: '/repo', appToolsEnabled, mode, hasNotesTab })

/** Prompt baseline, including the explicit Ask-to-Agent handoff exception. */
const LEGACY_PROMPT_HASHES = {
  'agent:false:false': 'af6de4656bb5f33db2a755cb273a73a5154ec4541b70ab3b55191b75d4323234',
  'agent:false:true': '7bed6172f8583abcb60a62f84a6fa6b3c97409093889405e3fadc19950e1c2a9',
  'agent:true:false': '36c35895aae810345d3ac53c891f8f17058e903b27206376dbdc5ece2313ca5b',
  'agent:true:true': '313586c419f21fe2266079218c63b18efb7d5c363ebc13af3c32d468b9ddbe4c',
  'ask:false:false': '058968494ee55e8f4866870925d4efa5009c563c2daae658af0e98365255d59e',
  'ask:false:true': '07d5d13841477179074453a08d2dc12bfd5a7cfc175c40cba11af4fc659d4ab5',
  'ask:true:false': 'e1e351510b918c5f82aac0d70a2cea4a1ef1a4e8b4dc1b0947f708b8bda1137d',
  'ask:true:true': '42ec2d5c44b0cb8d723efda081875e0d771d67c92d7913d70557ec74b766327e',
  'plan:false:false': 'deff6716608c378c1fb0a4f94eb29f38dbc33c9e8199bde181a3fbe6ea98fae5',
  'plan:false:true': 'cd3b6cffc799ce5de26bea4e5daf8e00e083aa6dd904cbacbff4937880618d89',
  'plan:true:false': '7ae52c142f90d1c66c34d19180fa3aab78ca034ac3667414c67e264fb6593738',
  'plan:true:true': 'a1c6d8f83034edd95eaada17d1dac864b5e15b651cdd64014d28a745701f40dc',
  'maestro:false:false': 'eca1cc783c8b158b94b234d6f51cad63c98212eaae05e5890d3129efba29ef23',
  'maestro:false:true': '954a29a8e2cf1a1975f1e02bd6aa6b323d15b361239fd2adb8d74035177f757a',
  'maestro:true:false': '23b4682ab1e7f7948bef1f9e3c33b4a81979b6f4a68f18554f6917842f8f156d',
  'maestro:true:true': '9f000c4c9e17d2a721c135fcdbf0bd0d207e7f2e881eed793d63b0d8be892ca4',
}

describe('Fable 5.1 prompt fragments', () => {
  it('captures legacy prompt hashes', () => {
    const hashes: Record<string, string> = {}
    for (const mode of ['agent', 'ask', 'plan', 'maestro'] as const) {
      for (const appToolsEnabled of [false, true]) {
        for (const hasNotesTab of [false, true]) {
          hashes[`${mode}:${appToolsEnabled}:${hasNotesTab}`] = createHash('sha256')
            .update(prompt(appToolsEnabled, mode, hasNotesTab))
            .digest('hex')
        }
      }
    }
    expect(hashes).toEqual(LEGACY_PROMPT_HASHES)
  })

  it('preserves legacy prompt bytes when no profile applies', () => {
    const legacy = 'legacy\n\nprompt'
    expect(harnessSubagentPrompt(legacy, generic)).toBe(legacy)
    expect(harnessCompactionSystem(legacy, generic)).toBe(legacy)
  })

  it('replaces conflicting legacy style while preserving mode capability barriers', () => {
    const agent = prompt(true, 'agent', false, fable)
    expect(agent).toContain('brief progress updates at meaningful milestones')
    expect(agent).toContain('complete closing summary')
    expect(agent).not.toContain("don't pad with caveats, recaps or repetition")
    expect(agent).not.toContain("don't restate the question or narrate routine steps")

    expect(prompt(true, 'ask', false, fable)).toContain('ASK MODE (restricted tools)')
    expect(prompt(true, 'ask', false, fable)).toContain('Do NOT edit project files or run commands')
    expect(prompt(true, 'ask', false, fable)).toContain('when start_conversations is exposed')
    expect(prompt(true, 'plan', false, fable)).toContain('Calling review_plan ENDS your turn')
    expect(prompt(true, 'maestro', false, fable)).toContain('parent is structurally read-only')
  })

  it('gives children role-appropriate instructions without user-facing progress', () => {
    const child = harnessSubagentPrompt('Base child contract.', fable)
    expect(child).toContain('maestrly-fable-5.1-v1')
    expect(child).toContain('report to the parent')
    expect(child).toContain('Do not address the user')
    expect(child).not.toContain('report progress to the user')
  })

  it('preserves decisions, rejected attempts, exact references and truthful checks in summaries', () => {
    const compact = harnessCompactionSystem('Legacy compact.', fable)
    expect(compact).toContain('rejected attempts')
    expect(compact).toContain('user constraints and decisions')
    expect(compact).toContain('exact references')
    expect(compact).toContain('Never invent')
  })

  it('declares the summarized progress contract and the bounded read-batching hook', () => {
    expect(fable.progress).toBe('summarized')
    expect(fable.hooks).toEqual([
      { id: 'post-tool-read-guidance', text: expect.stringContaining('group them in parallel'), maxReminders: 24 },
    ])
  })
})
