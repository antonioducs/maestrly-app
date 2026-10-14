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
  'agent:false:false': 'a5367a57add22edb057f844e20b0f8998b4c8802b407be41bea3d14bc50ce2a4',
  'agent:false:true': 'ec9b4ada0203b3dfa3b3b1a34da9fe844210ca1b05e86bed1eba58a43f89ea4f',
  'agent:true:false': '8363868af4433a6d34379035381819b630158c215e4d947dae0c467a738becdd',
  'agent:true:true': 'afaf4a6ff3faae47aaef7a4a879a3fec4b521ad52b223ab7d87a5085f5dc97e3',
  'ask:false:false': '6323d8bdc7ee98cff8b8e334caeeba8374470c01ecf3f17b17255be9ea94863e',
  'ask:false:true': '60f486c35410a1f841e901d8ebc11de07741922c94842226b31f6bf5d9c45145',
  'ask:true:false': '0fa15055672b69818fb6a4216d8e5a85c8d36f35d5555246b22ebbeab5327117',
  'ask:true:true': 'c873b4ffea8a81ce53b79f3491b61bb2d75ac1ad3cfeb8e568267998517749ef',
  'plan:false:false': '7cddb2ae5596ba23b197f1c04767810a6377fd055d563a1f9bb141892d87eb60',
  'plan:false:true': '1638db6bd8a34f2eb8078c90d2cb6b18f710925b411bbd5f5aba2dba9109ee3e',
  'plan:true:false': '09139ea94de7ee42767de3979815a33088c6d02564803e46ecf0babf75f2b9c3',
  'plan:true:true': '3d575f48951c6f8806cd45f0ee5e309512365cc62e8a67bc8b91bbe0bda39fc7',
  'maestro:false:false': 'ded9a6439b0aaffbbd923bf1ea1b8a0c0f336d33752edd5240d368f247763a93',
  'maestro:false:true': '026f8563b08b0adb4142a5e706273b7488c04da2c314de8d620ac9062cb30273',
  'maestro:true:false': 'af422b82bbe4469a64f963245a08be41faa7e5aa01a08f854ac3b1f2bee6d6d0',
  'maestro:true:true': '6e540f1c8ef452f3a5116aa3ea8d2d3f414f55bf0b53df84c95a95dcc3204bad',
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
