import { describe, expect, it } from 'vitest'

import { resolveGitHubCopilotHarness } from '../../src/main/chat/github-copilot/harness'

describe('GitHub Copilot model-aware harness', () => {
  it.each([
    'gpt-4.1',
    'chatgpt-4o-latest',
    'o1',
    'o3-mini',
    'o4-mini',
    'codex-mini-latest',
    'ft:gpt-4.1:acme:custom',
    'github-copilot/GPT-5.6-SOL',
  ])('routes %s through the OpenAI harness while preserving the Copilot transport', (modelId) => {
    expect(resolveGitHubCopilotHarness(modelId)).toMatchObject({
      family: 'openai',
      profile: 'copilot-openai-v1',
    })
  })

  it('reserves the ported Codex prompt for the exact gpt-5.6-sol model', () => {
    expect(resolveGitHubCopilotHarness(' github/gpt-5.6-sol ')).toEqual({
      family: 'openai',
      profile: 'copilot-openai-v1',
      promptProfile: 'codex-gpt-5.6-sol@5bed644',
    })
    expect(resolveGitHubCopilotHarness('gpt-5.6-sol-preview')).toEqual({
      family: 'openai',
      profile: 'copilot-openai-v1',
      promptProfile: 'maestrly-openai-generic-v1',
    })
  })

  it.each([
    'claude-sonnet-4.5',
    'CLAUDE_OPUS_4_1',
    'fable',
    'github/fable-xhigh',
  ])('keeps %s on the legacy Anthropic harness', (modelId) => {
    expect(resolveGitHubCopilotHarness(modelId)).toEqual({
      family: 'anthropic',
      profile: 'copilot-anthropic-v1',
      promptProfile: 'maestrly-legacy',
    })
  })

  it.each([
    'gemini-2.5-pro',
    'grok-code-fast-1',
    'deepseek-r1',
    '',
    'provider/model',
  ])('uses an explicit generic fallback for %j', (modelId) => {
    expect(resolveGitHubCopilotHarness(modelId)).toEqual({
      family: 'generic',
      profile: 'copilot-generic-v1',
      promptProfile: 'maestrly-legacy',
    })
  })
})
