import { tool, type ToolSet } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { closeAntigravityHostMcpServer } from '../../src/main/chat/antigravity-subscription/host-mcp'
import type { AntigravitySubscriptionManager } from '../../src/main/chat/antigravity-subscription/manager'
import {
  type RunAntigravitySubagentArgs,
  runAntigravitySubagent,
} from '../../src/main/chat/antigravity-subscription/subagent-runner'
import { createFakeAntigravity, type FakeAntigravity } from '../helpers/antigravity-fake'
import { closeDb, freshDb } from '../helpers/db'

const readExecute = vi.fn(async ({ path }: { path: string }) => `contents of ${path}`)
const tools: ToolSet = {
  read: tool({ description: 'Read a file.', inputSchema: z.object({ path: z.string() }), execute: readExecute }),
  write: tool({
    description: 'Write a file.',
    inputSchema: z.object({ path: z.string(), text: z.string() }),
    execute: async () => 'written',
  }),
  task: tool({ description: 'Delegate.', inputSchema: z.object({}), execute: async () => 'never' }),
}

let fake: FakeAntigravity
let manager: AntigravitySubscriptionManager

beforeEach(async () => {
  freshDb()
  fake = createFakeAntigravity()
  manager = fake.manager()
  await manager.login()
  readExecute.mockClear()
})
afterEach(async () => {
  await fake.cleanup()
  await closeAntigravityHostMcpServer()
  closeDb()
})

function args(taskText: string, overrides: Partial<RunAntigravitySubagentArgs> = {}): RunAntigravitySubagentArgs {
  return {
    manager,
    accountIdentity: manager.getAccountIdentity(),
    conversationId: 'conversation',
    cwd: '/tmp/project',
    profile: {
      version: 1,
      agentName: 'worker',
      attempts: [],
      effective: {
        providerId: 'builtin_antigravity_subscription',
        modelId: 'gemini-3.1-pro',
        configuredEffort: 'low',
        sentEffort: 'low',
        source: 'conversation-default',
        candidateIndex: 0,
      },
    } as RunAntigravitySubagentArgs['profile'],
    definition: {
      name: 'worker',
      description: 'Worker',
      prompt: 'Do the task.',
      source: 'test',
      tools: ['read', 'write', 'task'],
    } as RunAntigravitySubagentArgs['definition'],
    signal: new AbortController().signal,
    agentName: 'worker',
    task: taskText,
    readOnly: false,
    tools,
    ...overrides,
  }
}

const lastPromptText = () => {
  const params = fake.requests('session/prompt').at(-1)?.params as { prompt?: Array<{ text?: string }> } | undefined
  return params?.prompt?.[0]?.text ?? ''
}

describe('Antigravity subagent runner', () => {
  it('runs the child in its own session with only its allowed tools', async () => {
    const progress: string[] = []
    const updates: unknown[] = []
    const result = await runAntigravitySubagent(
      args('TOOL read {"path":"a.ts"}', {
        progress: (line) => progress.push(line),
        onTextUpdate: (update) => updates.push(update),
      })
    )
    expect(result).toEqual({
      text: 'tool-result:contents of a.ts',
      model: { providerId: 'builtin_antigravity_subscription', modelId: 'gemini-3.1-pro' },
    })
    expect(readExecute).toHaveBeenCalledTimes(1)
    expect(progress).toEqual(['Starting subagent worker', 'read started'])
    expect(updates.length).toBeGreaterThan(0)
    const prompt = lastPromptText()
    expect(prompt).toContain('You are the delegated Maestrly subagent "worker"')
    expect(prompt).toContain('- maestrly_read:')
    expect(prompt).toContain('- maestrly_write:')
    expect(prompt).not.toContain('maestrly_task')
    expect(prompt.endsWith('# Task\nTOOL read {"path":"a.ts"}')).toBe(true)
    expect(fake.requests('session/set_config_option').at(-1)?.params).toMatchObject({ value: 'gemini-3.1-pro-low' })
    await expect.poll(() => fake.requests('session/delete').length).toBeGreaterThan(0)
  })

  it('hides mutating tools from a read-only child', async () => {
    await runAntigravitySubagent(args('ECHO done', { readOnly: true }))
    const prompt = lastPromptText()
    expect(prompt).toContain('- maestrly_read:')
    expect(prompt).not.toContain('maestrly_write')
    expect(prompt).toContain('strictly read-only')
  })

  it('cancels the child session when aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('parent stopped')), 100)
    await expect(runAntigravitySubagent(args('SLOW', { signal: controller.signal }))).rejects.toThrow('parent stopped')
    await expect.poll(() => fake.requests('session/cancel').length).toBe(1)
  })

  it('reports an unavailable model as a child error', async () => {
    const input = args('ECHO x')
    const result = await runAntigravitySubagent({
      ...input,
      profile: { ...input.profile, effective: { ...input.profile.effective!, modelId: 'missing' } },
    })
    expect(result.error).toMatch(/missing/)
    expect(fake.requests('session/prompt')).toHaveLength(0)
  })
})
