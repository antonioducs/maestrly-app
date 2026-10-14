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

/** Prompt baseline, including the Ask exception for handoffs and projects the person wants, and generated interfaces. */
const LEGACY_PROMPT_HASHES = {
  'agent:false:false': '73fa1b1f52bfa9b8caa12af779ac3032e90dd12bf1d56e33479902122a36fafe',
  'agent:false:true': '9f66656381a9e52696e0144dfa58f07591d12f2847b4c603a33a933d67f1093e',
  'agent:true:false': 'c8558c18207b403669feb1efa64edc917731bd61103a05a4900b30ec96208126',
  'agent:true:true': 'f16d71082f9a0f25c335c41147fc94400cdd977b70bfa8e65f4c00e6ca0eacaf',
  'ask:false:false': '32cdcdabdeea24bb692bb388dbed7919843ff15c90359ef6060cc9a216dd4654',
  'ask:false:true': '708e06e505ae0ca27e2c19f7a3a0479903c2db2dd529e26a9d79b5cc9a196061',
  'ask:true:false': '18d876077b69e4ab34f0c66cbdc05f9c13bab96fa41fc1f88bc4ffbc8a55f435',
  'ask:true:true': '2037e7b50caa0f9dc6e11b6a7ffa328dff3b9c72a7fa2e34a88f4ed659964c40',
  'plan:false:false': '3b7416ebe102ffd1f56230eaa14ac6741b3d567e80924ed9037ba68205afdabe',
  'plan:false:true': 'b7e3f7998285fe9280d09d7be4be7925157655bef569b45536a24cba0de0ecc9',
  'plan:true:false': '7d4f8733ccbe3a641f1ad330e394a1de98352ab5b50c9f9b1a3ceaf8ad372e31',
  'plan:true:true': '5da73f443eb07c75073fd5e18e7b1d4dab28c481f03490c2eb1b48f8877314b1',
  'maestro:false:false': '9a750e97709d2a29d5ca98a980de83474d147c51cd62fe316c3b17c64da9b137',
  'maestro:false:true': '12bb2101a5e1abe74ea7c5c5f08506449ce332a035e68d74df81b8b8b2785dd8',
  'maestro:true:false': '5dda6712f0b47f152475979d3cbbdfa8b55d48926f26a81abf0d7affc4a0d3a3',
  'maestro:true:true': '0521d4923bb9d51e3910a84ebe983dd791abf6c162c52154823a007733f43ccb',
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
