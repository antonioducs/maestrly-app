import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonSchema, tool } from 'ai'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import { aggregateChatUsage, chatHistoryStats, listConversationContextMessages } from '../../src/main/chat/chat-store'
import { getToolExecution } from '../../src/main/chat/openai/inference-store'
import { wrapOpenAIToolExecutions } from '../../src/main/chat/openai/execution'
import { OpenAIToolScheduler } from '../../src/main/chat/openai/tools'
import { executeSubagent } from '../../src/main/chat/subagent-executor'
import { withSubagentMessageOwnership } from '../../src/main/chat/subagent-ownership'
import type { SubagentTextUpdate } from '../../src/main/chat/subagent-text-stream'

const h = vi.hoisted(() => ({ runSubagent: vi.fn() }))

vi.mock('../../src/main/chat/subagent-runner', () => ({
  namespaceSubagentToolCallId: (taskCallId: string, toolCallId: string) => `${taskCallId}:${toolCallId}`,
  runSubagent: h.runSubagent,
  subagentPermissionAssertInput: (input: unknown) => input,
}))

beforeEach(() => {
  freshDb()
  h.runSubagent.mockReset()
})
afterEach(closeDb)

describe('host-managed subagent message ownership', () => {
  it('runs standalone without a conversation FK or chat_message lifecycle and forwards text updates', async () => {
    const updates: SubagentTextUpdate[] = []
    h.runSubagent.mockImplementation(
      async ({ onTextUpdate }: { onTextUpdate?: (update: SubagentTextUpdate) => void }) => {
        expect(getDb().prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 })
        expect(getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages').get()).toEqual({ count: 0 })
        onTextUpdate?.({ kind: 'append', text: 'standalone result' })
        return { text: 'standalone result' }
      }
    )

    const result = await executeSubagent({
      conversationId: 'standalone-execution-without-conversation-row',
      projectId: 'standalone-project',
      cwd: '/tmp/standalone-project',
      parentMessageId: 'standalone-subagent-message',
      parentMessageOwnership: { kind: 'standalone' },
      mode: 'agent',
      permMode: 'full',
      profile: {
        version: 1,
        agentName: 'general-purpose',
        effective: {
          providerId: 'openai',
          modelId: 'gpt-5.6-codex',
          configuredEffort: 'off',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'general-purpose',
        description: 'test standalone worker',
        prompt: 'test standalone worker',
        source: 'built-in',
      },
      agentName: 'general-purpose',
      task: 'run without chat persistence',
      readOnly: true,
      broker: {} as never,
      questionBroker: {} as never,
      signal: new AbortController().signal,
      onTextUpdate: (update) => updates.push(update),
    })

    expect(result.text).toBe('standalone result')
    expect(updates).toEqual([{ kind: 'append', text: 'standalone result' }])
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages').get()).toEqual({ count: 0 })
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('runs the executor with a real OpenAI tool checkpoint and cascades it on intentional cleanup', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { mode: 'local' })
    const messageId = 'host-subagent-message'
    const execute = vi.fn(async () => ({ changed: true }))
    const wrapped = wrapOpenAIToolExecutions(
      {
        edit: tool({
          inputSchema: jsonSchema({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          }),
          execute,
        }),
      },
      new OpenAIToolScheduler(conversation.id),
      {
        conversationId: conversation.id,
        messageId,
        callIdPrefix: `subagent:${messageId}:task-1`,
      }
    )

    h.runSubagent.mockImplementation(async ({ tools }: { tools: typeof wrapped }) => {
      expect(getDb().prepare('SELECT role, meta_json FROM chat_messages WHERE id = ?').get(messageId)).toMatchObject({
        role: 'assistant',
      })
      expect(listConversationContextMessages(conversation.id)).toEqual([])

      await tools.edit.execute!({ path: 'conflict.ts' }, {
        toolCallId: 'call-1',
        messages: [],
        abortSignal: new AbortController().signal,
      } as never)

      expect(getToolExecution(conversation.id, `subagent:${messageId}:task-1:call-1`)).toMatchObject({
        messageId,
        status: 'completed',
      })
      return {
        text: 'resolved',
        usage: { input: 100, output: 20, cacheRead: 10, cacheCreate: 5, totalInput: 115 },
        model: { providerId: 'effective-provider', modelId: 'effective-model' },
        runtimeEstimatedCostUsd: 0.004,
      }
    })

    const result = await executeSubagent({
      conversationId: conversation.id,
      projectId: workspace.id,
      cwd: conversation.cwd,
      parentMessageId: messageId,
      parentMessageOwnership: { kind: 'host-managed', cleanup: 'delete' },
      mode: 'agent',
      permMode: 'full',
      profile: {
        version: 1,
        agentName: 'general-purpose',
        effective: {
          providerId: 'openai',
          modelId: 'gpt-5.6-codex',
          configuredEffort: 'off',
          sentEffort: null,
          source: 'parent',
          candidateIndex: 0,
        },
        attempts: [],
      },
      definition: {
        name: 'general-purpose',
        description: 'test worker',
        prompt: 'test worker',
        source: 'built-in',
      },
      agentName: 'general-purpose',
      task: 'resolve the conflict',
      readOnly: false,
      tools: wrapped,
      broker: {} as never,
      questionBroker: {} as never,
      signal: new AbortController().signal,
    })

    expect(result.text).toBe('resolved')
    expect(h.runSubagent).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?').get(messageId)).toEqual({
      count: 0,
    })
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM chat_tool_executions WHERE message_id = ?').get(messageId)
    ).toEqual({ count: 0 })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chat_usage_ledger').get()).toEqual({ count: 1 })
    const ledger = getDb().prepare('SELECT * FROM chat_usage_ledger WHERE message_id = ?').get(messageId) as {
      message_id: string
      provider_id: string
      model_id: string
      usage_json: string
    }
    expect(ledger).toMatchObject({
      message_id: messageId,
      provider_id: 'effective-provider',
      model_id: 'effective-model',
    })
    expect(JSON.parse(ledger.usage_json)).toEqual({
      usageVersion: 2,
      input: 100,
      output: 20,
      cachedInput: 10,
      cacheCreate: 5,
      billingOnly: true,
      runtimeEstimatedCostUsd: 0.004,
    })
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 0 })
    expect(aggregateChatUsage().perModel).toEqual([
      expect.objectContaining({
        providerId: 'effective-provider',
        modelId: 'effective-model',
        turns: 0,
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheCreate: 5,
        runtimeEstimatedCostUsd: 0.004,
      }),
    ])
    expect(chatHistoryStats(conversation.id)).toMatchObject({
      lastUsage: null,
      perModel: [
        expect.objectContaining({
          providerId: 'effective-provider',
          modelId: 'effective-model',
          input: 100,
          output: 20,
          cachedInput: 10,
          cacheCreate: 5,
          runtimeEstimatedCostUsd: 0.004,
        }),
      ],
    })
    expect(getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('preserves measured billing when a host-managed execution throws', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id, { mode: 'local' })
    const messageId = 'host-subagent-error'
    const error = Object.assign(new Error('worker failed after usage'), {
      subagentUsage: { input: 7, output: 3, cacheRead: 2, cacheCreate: 1, totalInput: 10 },
      subagentModel: { providerId: 'error-provider', modelId: 'error-model' },
      subagentRuntimeEstimatedCostUsd: 0.001,
    })

    await expect(
      withSubagentMessageOwnership({
        conversationId: conversation.id,
        messageId,
        model: { providerId: 'fallback-provider', modelId: 'fallback-model' },
        ownership: { kind: 'host-managed', cleanup: 'delete' },
        execute: async () => {
          throw error
        },
      })
    ).rejects.toBe(error)

    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?').get(messageId)).toEqual({
      count: 0,
    })
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM chat_tool_executions WHERE message_id = ?').get(messageId)
    ).toEqual({
      count: 0,
    })
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM chat_usage_ledger').get()).toEqual({ count: 1 })
    expect(aggregateChatUsage()).toMatchObject({ totalTurns: 0 })
    expect(aggregateChatUsage().perModel[0]).toMatchObject({
      providerId: 'error-provider',
      modelId: 'error-model',
      input: 7,
      output: 3,
      cacheRead: 2,
      cacheCreate: 1,
      runtimeEstimatedCostUsd: 0.001,
      turns: 0,
    })
  })
})
