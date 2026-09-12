import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { CopilotSession, SessionEvent, Tool as CopilotTool } from '@github/copilot-sdk'
import { runGitHubCopilotSubagent } from '../../src/main/chat/github-copilot/subagent-runner'
import type {
  GitHubCopilotAccountIdentity,
  GitHubCopilotCreateSessionConfig,
  GitHubCopilotSubscriptionManager,
} from '../../src/main/chat/github-copilot/manager'
import {
  getGitHubCopilotSessionBinding,
  listGitHubCopilotSessionCleanup,
} from '../../src/main/chat/github-copilot/session-store'
import { closeDb, freshDb } from '../helpers/db'
import type { SubagentTextUpdate } from '../../src/main/chat/subagent-text-stream'

const identity: GitHubCopilotAccountIdentity = { fingerprint: 'sha256:copilot-account', epoch: 3 }

function event(type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

function profile(modelId = 'claude-sonnet-4.6') {
  return {
    version: 1 as const,
    agentName: 'reviewer',
    effective: {
      providerId: 'builtin_github_copilot_subscription',
      modelId,
      configuredEffort: 'high',
      sentEffort: 'high',
      source: 'conversation-default' as const,
      candidateIndex: 0,
    },
    attempts: [],
  }
}

const definition = {
  name: 'reviewer',
  description: 'Reviews code',
  prompt: 'Review carefully.',
  source: '.claude/agents/reviewer.md',
  tools: ['read', 'grep', 'bash', 'task', 'review_plan', 'generate_image', 'use_skill'],
}

function tools(): CopilotTool[] {
  return ['read', 'grep', 'bash', 'task', 'review_plan', 'generate_image', 'use_skill'].map((name) => ({
    name,
    parameters: { type: 'object' },
    defer: name === 'grep' ? ('auto' as const) : ('never' as const),
    handler: vi.fn(async () => 'ok'),
  }))
}

class FakeManager {
  readonly createCalls: GitHubCopilotCreateSessionConfig[] = []
  readonly disconnectSession = vi.fn(async () => {})
  readonly deleteSession = vi.fn(async () => {})
  readonly assertAccountIdentity = vi.fn((expected: GitHubCopilotAccountIdentity) => {
    if (expected.fingerprint !== identity.fingerprint || expected.epoch !== identity.epoch) throw new Error('changed')
  })
  readonly abort = vi.fn(async () => {})
  script: (config: GitHubCopilotCreateSessionConfig) => Promise<unknown> = async () => undefined

  async createSession(config: GitHubCopilotCreateSessionConfig): Promise<CopilotSession> {
    this.createCalls.push(config)
    return {
      sessionId: 'copilot-child-1',
      abort: this.abort,
      sendAndWait: () => this.script(config),
    } as unknown as CopilotSession
  }
}

function args(manager: FakeManager, signal = new AbortController().signal) {
  return {
    manager: manager as unknown as GitHubCopilotSubscriptionManager,
    accountIdentity: identity,
    conversationId: 'conversation-1',
    cwd: '/repo',
    profile: profile(),
    definition,
    signal,
    agentName: 'reviewer',
    task: 'Inspect the implementation.',
    readOnly: true,
    tools: tools(),
  }
}

describe('GitHub Copilot ephemeral subagent runner', () => {
  beforeEach(() => freshDb())
  afterEach(closeDb)

  it('sends the exact model and effort, filters tools, captures progress/usage, and deletes the session', async () => {
    const manager = new FakeManager()
    const progress: string[] = []
    const textUpdates: SubagentTextUpdate[] = []
    manager.script = async (config) => {
      config.onEvent?.(event('tool.execution_start', { toolCallId: 'child-tool', toolName: 'read' }))
      config.onEvent?.(event('tool.execution_progress', { toolCallId: 'child-tool', progressMessage: 'reading' }))
      config.onEvent?.(event('assistant.message_delta', { messageId: 'child-answer', deltaContent: 'partial' }))
      config.onEvent?.(event('assistant.message', { messageId: 'child-answer', content: 'Final review.' }))
      config.onEvent?.(
        event('assistant.usage', {
          inputTokens: 100,
          outputTokens: 5,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
        })
      )
      return event('assistant.message', { messageId: 'child-answer', content: 'Final review.' })
    }

    await expect(
      runGitHubCopilotSubagent({
        ...args(manager),
        readOnly: false,
        progress: (line) => progress.push(line),
        onTextUpdate: (update) => textUpdates.push(update),
      })
    ).resolves.toEqual({
      text: 'Final review.',
      model: { providerId: 'builtin_github_copilot_subscription', modelId: 'claude-sonnet-4.6' },
      usage: { input: 70, output: 5, cacheRead: 20, cacheCreate: 10, totalInput: 100 },
    })

    expect(manager.createCalls[0]).toMatchObject({
      model: 'claude-sonnet-4.6',
      reasoningEffort: 'high',
      workingDirectory: '/repo',
      availableTools: ['custom:read', 'custom:grep', 'custom:bash', 'custom:generate_image'],
      toolSearch: { enabled: true, deferThreshold: 0 },
      customAgents: [],
      enableSessionStore: false,
      systemMessage: { mode: 'replace' },
    })
    expect(manager.createCalls[0].systemMessage).toMatchObject({
      content: expect.stringContaining('Review carefully.'),
    })
    expect(manager.createCalls[0]?.systemMessage?.content).toContain('# Durable project memory')
    expect(manager.createCalls[0].availableTools).not.toContain('custom:task')
    expect(manager.createCalls[0].availableTools).not.toContain('custom:use_skill')
    expect(manager.createCalls[0].availableTools).toContain('custom:generate_image')
    expect(manager.createCalls[0].tools).toMatchObject([
      { name: 'read', defer: 'never' },
      { name: 'grep', defer: 'auto' },
      { name: 'bash', defer: 'never' },
      { name: 'generate_image', defer: 'never' },
    ])
    expect(progress).toEqual(['Starting subagent reviewer', 'read started', 'reading'])
    expect(textUpdates).toEqual([
      { kind: 'append', text: 'partial' },
      { kind: 'replace', text: 'Final review.' },
    ])
    expect(manager.abort).toHaveBeenCalledOnce()
    expect(manager.disconnectSession).toHaveBeenCalledWith('copilot-child-1')
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-child-1')
    expect(getGitHubCopilotSessionBinding('conversation-1')).toBeNull()
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('exposes the host-governed skill loader only for a Maestro worker', async () => {
    const manager = new FakeManager()
    await runGitHubCopilotSubagent({ ...args(manager), readOnly: false, allowSkillLoader: true })

    expect(manager.createCalls[0].availableTools).toContain('custom:use_skill')
    expect(manager.createCalls[0].enableSkills).toBe(false)
  })

  it('applies only the behavioral prompt for an exact Fable child', async () => {
    const manager = new FakeManager()
    await runGitHubCopilotSubagent({ ...args(manager), profile: profile('claude-fable-5-1') })

    expect(manager.createCalls[0]).toMatchObject({
      model: 'claude-fable-5-1',
      systemMessage: { mode: 'replace', content: expect.stringContaining('maestrly-fable-5.1-v1') },
    })
    expect(manager.createCalls[0]).not.toHaveProperty('thinking')
    expect(manager.createCalls[0]).not.toHaveProperty('betas')
    expect(manager.createCalls[0].availableTools).not.toContain('custom:task')
  })

  it('retains generate_image only when provided by the host to a mutable worker', async () => {
    const manager = new FakeManager()
    const provided = tools()
    const providedImage = provided.find((entry) => entry.name === 'generate_image')
    manager.script = async (config) => {
      const exposed = config.tools?.find((entry) => entry.name === 'generate_image')
      await exposed?.handler?.({}, { toolCallId: 'child-image-call' } as never)
      return event('assistant.message', { messageId: 'child-answer', content: 'ok' })
    }

    await runGitHubCopilotSubagent({ ...args(manager), readOnly: false, tools: provided })
    expect(providedImage?.handler).toHaveBeenCalledWith({}, { toolCallId: 'child-image-call' })

    const withoutHost = provided.filter((entry) => entry.name !== 'generate_image')
    await runGitHubCopilotSubagent({ ...args(manager), readOnly: false, tools: withoutHost })
    expect(manager.createCalls.at(-1)?.availableTools).not.toContain('custom:generate_image')

    const readOnlyManager = new FakeManager()
    await runGitHubCopilotSubagent({ ...args(readOnlyManager), tools: provided })
    expect(readOnlyManager.createCalls[0].availableTools).not.toContain('custom:generate_image')
  })

  it('preserves usage and cleans up when the child fails', async () => {
    const manager = new FakeManager()
    manager.script = async (config) => {
      config.onEvent?.(event('assistant.usage', { inputTokens: 12, outputTokens: 2, cacheReadTokens: 3 }))
      throw new Error('runtime failed')
    }

    await expect(runGitHubCopilotSubagent(args(manager))).resolves.toMatchObject({
      error: 'runtime failed',
      usage: { input: 9, output: 2, cacheRead: 3, cacheCreate: 0, totalInput: 12 },
    })
    expect(manager.abort).toHaveBeenCalledOnce()
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-child-1')
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })

  it('interrupts and deletes the session on abort', async () => {
    const manager = new FakeManager()
    const controller = new AbortController()
    let release!: () => void
    const aborted = new Promise<void>((resolve) => {
      release = resolve
    })
    manager.abort.mockImplementation(async () => release())
    manager.script = async () => {
      await aborted
      return undefined
    }

    const running = runGitHubCopilotSubagent(args(manager, controller.signal))
    await vi.waitFor(() => expect(manager.createCalls).toHaveLength(1))
    controller.abort()

    await expect(running).rejects.toMatchObject({ message: 'Subagent aborted' })
    expect(manager.abort).toHaveBeenCalled()
    expect(manager.disconnectSession).toHaveBeenCalledWith('copilot-child-1')
    expect(manager.deleteSession).toHaveBeenCalledWith('copilot-child-1')
    expect(listGitHubCopilotSessionCleanup()).toEqual([])
  })
})
