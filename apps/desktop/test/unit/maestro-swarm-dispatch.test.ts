import { describe, expect, it, vi } from 'vitest'
import {
  MAESTRO_WORKER_FOOTER,
  composeMaestroWorkerPrompt,
  resolveMaestroDispatchAgent,
} from '../../src/main/chat/maestro-swarm-dispatch'
import { resolveConversationDispatchSettingsFor } from '../../src/main/conversation-dispatch-service'
import type { ResolvedConversationDispatchSettings } from '../../src/main/conversation-dispatch-settings'
import type { ConversationDispatchSettingsRequest } from '../../src/shared/conversation-dispatch'
import type { MaestroResourceV1 } from '../../src/shared/maestro'

function makeResource(overrides: Partial<MaestroResourceV1> & Pick<MaestroResourceV1, 'id'>): MaestroResourceV1 {
  return {
    label: overrides.id,
    enabled: true,
    description: `${overrides.id} description`,
    mode: 'agent',
    specialties: [],
    candidates: [],
    ...overrides,
  }
}

describe('resolveMaestroDispatchAgent', () => {
  it('falls back from the first invalid candidate to the second and passes mode in each request', async () => {
    const coder = makeResource({
      id: 'coder',
      mode: 'agent',
      candidates: [
        { providerId: 'anthropic', modelId: 'claude-opus', effort: 'high' },
        { providerId: 'openai', modelId: 'gpt-5', effort: 'medium', fastMode: true },
      ],
    })
    const resolvedSettings = {
      providerId: 'openai',
      modelId: 'gpt-5',
      reasoning: 'medium',
      fastMode: true,
    }
    const resolve = vi
      .fn<(requested: ConversationDispatchSettingsRequest) => Promise<ResolvedConversationDispatchSettings>>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'provider-unavailable',
        message: 'Provider "anthropic" is not signed in.',
      })
      .mockResolvedValueOnce({
        ok: true,
        settings: resolvedSettings,
        inherited: [],
      })

    const result = await resolveMaestroDispatchAgent({
      pool: [coder],
      agentId: 'Coder',
      supportedModes: ['agent', 'design', 'ask'],
      resolve,
    })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenNthCalledWith(1, {
      providerId: 'anthropic',
      modelId: 'claude-opus',
      reasoning: 'high',
      fastMode: false,
      mode: 'agent',
    })
    expect(resolve).toHaveBeenNthCalledWith(2, {
      providerId: 'openai',
      modelId: 'gpt-5',
      reasoning: 'medium',
      fastMode: true,
      mode: 'agent',
    })
    expect(result).toEqual({
      ok: true,
      resource: coder,
      settings: resolvedSettings,
      mode: 'agent',
    })
  })

  it('calls resolve with only mode when a resource has no candidates', async () => {
    const reviewer = makeResource({
      id: 'reviewer',
      mode: 'ask',
      candidates: [],
    })
    const resolvedSettings = {
      providerId: 'openai',
      modelId: 'gpt-5',
      reasoning: 'high',
      fastMode: false,
      mode: 'ask' as const,
    }
    const resolve = vi
      .fn<(requested: ConversationDispatchSettingsRequest) => Promise<ResolvedConversationDispatchSettings>>()
      .mockResolvedValue({
        ok: true,
        settings: resolvedSettings,
        inherited: ['providerId', 'modelId', 'reasoning', 'fastMode'],
      })

    const result = await resolveMaestroDispatchAgent({
      pool: [reviewer],
      agentId: 'reviewer',
      supportedModes: ['agent', 'design', 'ask'],
      resolve,
    })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith({ mode: 'ask' })
    expect(result).toEqual({
      ok: true,
      resource: reviewer,
      settings: resolvedSettings,
      mode: 'ask',
    })
  })

  it('returns agent-unavailable with the resolve message when a candidate-less resource fails', async () => {
    const reviewer = makeResource({
      id: 'reviewer',
      mode: 'ask',
      candidates: [],
    })
    const resolve = vi
      .fn<(requested: ConversationDispatchSettingsRequest) => Promise<ResolvedConversationDispatchSettings>>()
      .mockResolvedValue({
        ok: false,
        error: 'no-source-model',
        message: 'No model is configured on the source conversation.',
      })

    const result = await resolveMaestroDispatchAgent({
      pool: [reviewer],
      agentId: 'reviewer',
      supportedModes: ['agent', 'design', 'ask'],
      resolve,
    })

    expect(result).toEqual({
      ok: false,
      error: 'agent-unavailable',
      message: 'No model of resource "reviewer" is available:\nNo model is configured on the source conversation.',
    })
  })

  it('returns agent-unavailable listing every candidate failure when all candidates fail', async () => {
    const coder = makeResource({
      id: 'coder',
      candidates: [
        { providerId: 'anthropic', modelId: 'claude-opus', effort: 'high' },
        { providerId: 'openai', modelId: 'gpt-5', effort: 'xhigh', fastMode: false },
      ],
    })
    const resolve = vi
      .fn<(requested: ConversationDispatchSettingsRequest) => Promise<ResolvedConversationDispatchSettings>>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'provider-unavailable',
        message: 'Not authenticated.',
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'reasoning-unsupported',
        message: 'Effort "xhigh" is unsupported.',
      })

    const result = await resolveMaestroDispatchAgent({
      pool: [coder],
      agentId: 'coder',
      supportedModes: ['agent'],
      resolve,
    })

    expect(result).toEqual({
      ok: false,
      error: 'agent-unavailable',
      message: [
        'No model of resource "coder" is available:',
        'anthropic/claude-opus: Not authenticated.',
        'openai/gpt-5: Effort "xhigh" is unsupported.',
      ].join('\n'),
    })
  })

  it('returns unknown-agent for unknown or disabled ids and lists only enabled ids', async () => {
    const pool = [
      makeResource({ id: 'alpha', enabled: true }),
      makeResource({ id: 'disabled-agent', enabled: false }),
      makeResource({ id: 'beta', enabled: true }),
    ]
    const resolve = vi.fn()

    const unknownResult = await resolveMaestroDispatchAgent({
      pool,
      agentId: 'missing',
      supportedModes: ['agent'],
      resolve,
    })
    expect(unknownResult).toEqual({
      ok: false,
      error: 'unknown-agent',
      message: 'Unknown Agent Pool resource "missing". Enabled resources: alpha, beta.',
    })

    const disabledResult = await resolveMaestroDispatchAgent({
      pool,
      agentId: 'disabled-agent',
      supportedModes: ['agent'],
      resolve,
    })
    expect(disabledResult).toEqual({
      ok: false,
      error: 'unknown-agent',
      message: 'Unknown Agent Pool resource "disabled-agent". Enabled resources: alpha, beta.',
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('returns mode-unavailable without calling resolve when resource mode is not in supportedModes', async () => {
    const designer = makeResource({
      id: 'designer',
      mode: 'design',
      candidates: [{ providerId: 'anthropic', modelId: 'claude-sonnet', effort: 'medium' }],
    })
    const resolve = vi.fn()

    const result = await resolveMaestroDispatchAgent({
      pool: [designer],
      agentId: 'designer',
      supportedModes: ['agent'],
      resolve,
    })

    expect(result).toEqual({
      ok: false,
      error: 'mode-unavailable',
      message: 'Resource "designer" runs in design mode, which conversations cannot start in yet.',
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a design resource with mode design when design is supported', async () => {
    const designer = makeResource({
      id: 'designer',
      mode: 'design',
      candidates: [{ providerId: 'anthropic', modelId: 'claude-sonnet', effort: 'medium' }],
    })
    const resolvedSettings = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      reasoning: 'medium',
      fastMode: false,
      mode: 'design' as const,
    }
    const resolve = vi
      .fn<(requested: ConversationDispatchSettingsRequest) => Promise<ResolvedConversationDispatchSettings>>()
      .mockResolvedValue({
        ok: true,
        settings: resolvedSettings,
        inherited: [],
      })

    const result = await resolveMaestroDispatchAgent({
      pool: [designer],
      agentId: 'designer',
      supportedModes: ['agent', 'design', 'ask'],
      resolve,
    })

    expect(resolve).toHaveBeenCalledWith({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      reasoning: 'medium',
      fastMode: false,
      mode: 'design',
    })
    expect(result).toEqual({
      ok: true,
      resource: designer,
      settings: resolvedSettings,
      mode: 'design',
    })
  })
})

describe('composeMaestroWorkerPrompt', () => {
  it('composes Role, Task, and footer in order when instructions are provided', () => {
    const prompt = composeMaestroWorkerPrompt({
      instructions: '  Focus on clean TypeScript and thorough tests.  ',
      task: '  Implement the swarm dispatch resolver.  ',
    })

    const roleIndex = prompt.indexOf('# Role\nFocus on clean TypeScript and thorough tests.')
    const taskIndex = prompt.indexOf('# Task\nImplement the swarm dispatch resolver.')
    const footerIndex = prompt.indexOf(MAESTRO_WORKER_FOOTER)

    expect(roleIndex).toBe(0)
    expect(taskIndex).toBeGreaterThan(roleIndex)
    expect(footerIndex).toBeGreaterThan(taskIndex)
    expect(prompt).toBe(
      `# Role\nFocus on clean TypeScript and thorough tests.\n\n# Task\nImplement the swarm dispatch resolver.\n\n${MAESTRO_WORKER_FOOTER}`
    )
  })

  it('omits Role when instructions are omitted or blank', () => {
    const withoutInstructions = composeMaestroWorkerPrompt({
      task: '  Fix the bug.  ',
    })
    expect(withoutInstructions).not.toContain('# Role')
    expect(withoutInstructions.indexOf('# Task\nFix the bug.')).toBe(0)
    expect(withoutInstructions.indexOf(MAESTRO_WORKER_FOOTER)).toBeGreaterThan(
      withoutInstructions.indexOf('# Task\nFix the bug.')
    )
    expect(withoutInstructions).toBe(`# Task\nFix the bug.\n\n${MAESTRO_WORKER_FOOTER}`)

    const blankInstructions = composeMaestroWorkerPrompt({
      instructions: '   \n\t  ',
      task: 'Fix the bug.',
    })
    expect(blankInstructions).not.toContain('# Role')
    expect(blankInstructions).toBe(withoutInstructions)
  })
})

describe('resolveConversationDispatchSettingsFor export', () => {
  it('is exported as a function from conversation-dispatch-service', () => {
    expect(typeof resolveConversationDispatchSettingsFor).toBe('function')
  })
})
