import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonSchema, tool } from 'ai'
import { freshDb, closeDb, restartDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getDb } from '../../src/main/store'
import { upsertChatMessage } from '../../src/main/chat/chat-store'
import {
  createSubagentSession,
  getSubagentRuntimeHandle,
  getSubagentSession,
  getSubagentTranscriptChanges,
  getSubagentTranscriptPage,
  markInterruptedSubagentSessions,
  updateSubagentSession,
  upsertSubagentTranscriptPart,
} from '../../src/main/chat/subagent-session-store'
import { createSubagentSessionRecorder, waitForSubagentSession } from '../../src/main/chat/subagent-session'
import { toolOutputText } from '../../src/shared/chat'

function fixture() {
  const workspace = makeWorkspace()
  const conversation = makeConversation(workspace.id)
  const parentMessageId = 'assistant-parent'
  upsertChatMessage({
    id: parentMessageId,
    conversationId: conversation.id,
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
  })
  return { conversation, parentMessageId }
}

describe('observable subagent sessions', () => {
  beforeEach(freshDb)
  afterEach(closeDb)

  it('persists a child transcript separately and cascades with the parent message', () => {
    const { conversation, parentMessageId } = fixture()
    const session = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'task-1',
      origin: 'task',
      agentName: 'explore',
      task: 'Inspect the implementation.',
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 'answer-1',
      position: 1,
      part: { type: 'text', id: 'answer-1', text: 'Found the relevant files.' },
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 'tool-1',
      position: 2,
      part: {
        type: 'tool',
        id: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'read',
        input: { path: 'src/app.ts' },
        state: { status: 'completed', output: 'ok' },
      },
    })
    updateSubagentSession(session.id, { status: 'completed', finishedAt: Date.now(), toolNames: ['read'] })

    const page = getSubagentTranscriptPage(session.id)
    expect(page?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(page?.messages[1]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Found the relevant files.' }),
        expect.objectContaining({ type: 'tool', toolName: 'read' }),
      ])
    )
    expect(getSubagentSession(session.id)?.toolNames).toEqual(['read'])

    getDb().prepare('DELETE FROM chat_messages WHERE id = ?').run(parentMessageId)
    expect(getSubagentSession(session.id)).toBeNull()
    expect(
      getDb().prepare('SELECT COUNT(*) AS count FROM chat_subagent_transcript').get() as { count: number }
    ).toEqual({ count: 0 })
  })

  it('returns idempotent cursor deltas and marks live sessions interrupted after restart recovery', async () => {
    const { conversation, parentMessageId } = fixture()
    const session = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-1',
      origin: 'delegate',
      agentName: 'worker',
      task: 'Work for a while.',
    })
    upsertSubagentTranscriptPart({
      sessionId: session.id,
      partId: 'text-1',
      part: { type: 'text', id: 'text-1', text: 'progress' },
    })
    const first = await waitForSubagentSession(session.id, 0, 0)
    expect(first?.changes).toHaveLength(2)
    const repeated = getSubagentTranscriptChanges(session.id, first!.cursor)
    expect(repeated).toEqual([])

    expect(markInterruptedSubagentSessions()).toBe(1)
    expect(getSubagentSession(session.id)?.status).toBe('interrupted')
  })

  it('records coalesced public text and complete tool lifecycle through one provider-neutral wrapper', async () => {
    vi.useFakeTimers()
    const { conversation, parentMessageId } = fixture()
    const recorder = createSubagentSessionRecorder({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'task-observed',
      origin: 'task',
      agentName: 'worker',
      task: 'Read one file.',
    })
    recorder.text({ kind: 'append', text: 'Reading' })
    recorder.text({ kind: 'append', text: ' now' })
    const execute = vi.fn(async () => ({ text: 'file contents Bearer very-secret-token' }))
    const tools = recorder.instrumentTools({
      read: tool({
        description: 'read',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { path: { type: 'string' }, api_key: { type: 'string' } },
          required: ['path'],
        }),
        execute,
      }),
    })
    await (tools.read as { execute: (...args: any[]) => Promise<unknown> }).execute(
      { path: 'src/app.ts', api_key: 'sk-super-secret-value' },
      { toolCallId: 'child-tool-1' }
    )
    recorder.complete({ status: 'completed' })
    await vi.runAllTimersAsync()
    vi.useRealTimers()

    const page = getSubagentTranscriptPage(recorder.id)
    const assistant = page?.messages.find((message) => message.role === 'assistant')
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'Reading now' }),
        expect.objectContaining({
          type: 'tool',
          toolName: 'read',
          state: expect.objectContaining({ status: 'completed' }),
        }),
      ])
    )
    const storedTool = assistant?.parts.find((part) => part.type === 'tool')
    expect(storedTool).toMatchObject({ input: { path: 'src/app.ts', api_key: '[redacted]' } })
    if (storedTool?.type === 'tool' && storedTool.state.status === 'completed') {
      expect(toolOutputText(storedTool.state.output)).toBe('file contents Bearer ***')
    }
    expect(getSubagentSession(recorder.id)).toMatchObject({
      status: 'completed',
      toolNames: ['read'],
      files: ['src/app.ts'],
    })
  })

  it('persists Maestro continuity (lineage, outcome, native handle) across a restart without leaking the handle', () => {
    const columns = (getDb().prepare('PRAGMA table_info(chat_subagent_sessions)').all() as Array<{ name: string }>).map(
      (column) => column.name
    )
    expect(columns).toEqual(
      expect.arrayContaining(['resumed_from', 'resume_status', 'resume_reason', 'runtime_handle_json'])
    )

    const { conversation, parentMessageId } = fixture()
    const first = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-author-1',
      origin: 'delegate',
      agentName: 'author',
      task: 'Write it.',
    })
    updateSubagentSession(first.id, {
      status: 'completed',
      finishedAt: Date.now(),
      runtimeHandle: { kind: 'codex-thread', threadId: 'thread_author', accountId: null, toolSignature: 'sig' },
    })
    const second = createSubagentSession({
      conversationId: conversation.id,
      parentMessageId,
      toolCallId: 'delegate-author-2',
      origin: 'delegate',
      agentName: 'author',
      task: 'Fix the findings.',
      resumedFrom: first.id,
    })
    updateSubagentSession(second.id, { resume: { status: 'recreated', reason: 'tools-changed' } })

    restartDb()

    expect(getSubagentRuntimeHandle(first.id)).toEqual({
      kind: 'codex-thread',
      threadId: 'thread_author',
      accountId: null,
      toolSignature: 'sig',
    })
    const summary = getSubagentSession(second.id)
    expect(summary).toMatchObject({ resumedFrom: first.id, resumeStatus: 'recreated', resumeReason: 'tools-changed' })
    expect(JSON.stringify(getSubagentSession(first.id))).not.toContain('thread_author')
    expect(getSubagentSession(first.id)?.resumedFrom).toBeUndefined()

    updateSubagentSession(first.id, { runtimeHandle: null })
    expect(getSubagentRuntimeHandle(first.id)).toBeNull()
  })
})
