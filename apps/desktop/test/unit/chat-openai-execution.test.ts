import { describe, expect, it, vi } from 'vitest'
import { openai } from '@ai-sdk/openai'
import { jsonSchema, tool, type ToolSet } from 'ai'
import {
  hashOpenAIToolInput,
  patchOpenAIToolExecutionOutputs,
  type OpenAIToolReplayError,
  reconcileOpenAIToolExecutions,
  wrapOpenAIToolExecutions,
  type OpenAIToolExecutionStore,
} from '../../src/main/chat/openai/execution'
import type { ToolExecutionRecord } from '../../src/main/chat/openai/inference-store'
import { captureOpenAIResponsesStream, replayOpenAIResponsesLedger } from '../../src/main/chat/openai/ledger'
import { OpenAIToolScheduler } from '../../src/main/chat/openai/tools'
import {
  isOpenAINativePermissionDeniedOutput,
  openAINativeFailureOutput,
} from '../../src/main/chat/openai/native-tools'

const options = (toolCallId: string) => ({ toolCallId, messages: [], abortSignal: new AbortController().signal }) as any
const scope = { conversationId: 'c1', messageId: 'message-1' }

const memoryStore = (): OpenAIToolExecutionStore & { rows: Map<string, ToolExecutionRecord> } => {
  const rows = new Map<string, ToolExecutionRecord>()
  return {
    rows,
    get: (conversationId, callId) => rows.get(`${conversationId}:${callId}`) ?? null,
    put: (record) => rows.set(`${record.conversationId}:${record.callId}`, structuredClone(record)),
  }
}

const mutationTool = (execute: (input: any) => unknown): ToolSet => ({
  edit: tool({
    inputSchema: jsonSchema({
      type: 'object',
      properties: { path: { type: 'string' }, value: { type: 'string' } },
      required: ['path', 'value'],
      additionalProperties: false,
    }),
    execute,
  }),
})

describe('OpenAI tool execution ledger', () => {
  it('hashes equivalent JSON regardless of key order', () => {
    expect(hashOpenAIToolInput({ b: 2, a: { d: 4, c: 3 } })).toBe(hashOpenAIToolInput({ a: { c: 3, d: 4 }, b: 2 }))
  })

  it('sorts idempotency keys independently of ICU', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale-dependent comparator must not run')
    })
    try {
      expect(hashOpenAIToolInput({ z: 1, ä: 2, a: 3 })).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      localeCompare.mockRestore()
    }
  })

  it('executes mutations once and reuses persisted call results', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const store = memoryStore()
    const wrapped = wrapOpenAIToolExecutions(mutationTool(execute), new OpenAIToolScheduler('c1'), scope, store)
    const input = { path: 'a.ts', value: 'next' }

    await expect(wrapped.edit.execute!(input, options('call-1'))).resolves.toEqual({ ok: true })
    await expect(wrapped.edit.execute!(input, options('call-1'))).resolves.toEqual({ ok: true })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(store.rows.get('c1:call-1')).toMatchObject({ status: 'completed', output: { ok: true } })
  })

  it('namespaces subagent checkpoints without changing transcript IDs', async () => {
    const execute = vi.fn(
      async (_input: unknown, executionOptions: { toolCallId: string }) => executionOptions.toolCallId
    )
    const store = memoryStore()
    const wrapped = wrapOpenAIToolExecutions(
      {
        edit: tool({
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute,
        }),
      },
      new OpenAIToolScheduler('c1'),
      { ...scope, callIdPrefix: 'subagent:message-1:task-1' },
      store
    )

    await expect(wrapped.edit.execute!({}, options('call-1'))).resolves.toBe('subagent:message-1:task-1:call-1')
    await expect(wrapped.edit.execute!({}, options('call-1'))).resolves.toBe('subagent:message-1:task-1:call-1')
    expect(execute).toHaveBeenCalledOnce()
    expect(store.rows.has('c1:call-1')).toBe(false)
    expect(store.rows.get('c1:subagent:message-1:task-1:call-1')).toMatchObject({ messageId: scope.messageId })

    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'edit', input: {} },
    ])
    expect(
      reconcileOpenAIToolExecutions(interrupted, { ...scope, callIdPrefix: 'subagent:message-1:task-1' }, store)
        .recovered
    ).toEqual([{ callId: 'call-1', status: 'completed' }])
  })

  it('checkpoints explicitly parallel mutations idempotently', async () => {
    const execute = vi.fn(async () => 'delegated')
    const store = memoryStore()
    const wrapped = wrapOpenAIToolExecutions(
      {
        task: tool({
          metadata: { parallelSafe: true, readOnly: false },
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute,
        }),
      },
      new OpenAIToolScheduler('c1'),
      scope,
      store
    )

    await wrapped.task.execute!({}, options('call-task'))
    await wrapped.task.execute!({}, options('call-task'))

    expect(execute).toHaveBeenCalledTimes(1)
    expect(store.rows.get('c1:call-task')).toMatchObject({ status: 'completed', output: 'delegated' })
  })

  it('persists native denial JSON without repeating mutations', async () => {
    const deniedOutput = openAINativeFailureOutput('apply_patch', 'no', true)! as {
      status: 'failed'
      output: string
    }
    const execute = vi.fn(async () => deniedOutput)
    const store = memoryStore()
    const wrapped = wrapOpenAIToolExecutions(
      { apply_patch: openai.tools.applyPatch({ execute }) },
      new OpenAIToolScheduler('c1'),
      scope,
      store
    )
    const input = {
      callId: 'call-denied',
      operation: { type: 'create_file' as const, path: 'no.txt', diff: '+no' },
    }

    const first = await wrapped.apply_patch.execute!(input, options('call-denied'))
    const replayed = await wrapped.apply_patch.execute!(input, options('call-denied'))
    expect(first).toEqual(deniedOutput)
    expect(replayed).toEqual(deniedOutput)
    expect(isOpenAINativePermissionDeniedOutput('apply_patch', replayed)).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(store.rows.get('c1:call-denied')).toMatchObject({ status: 'denied', output: deniedOutput })

    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-denied', toolName: 'apply_patch', input },
    ])
    const recovered = reconcileOpenAIToolExecutions(interrupted, scope, store)
    expect(replayOpenAIResponsesLedger(recovered.ledger).messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-denied' }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', output: { type: 'json', value: deniedOutput } }],
      },
    ])
  })

  it('persists schema-valid native failures as errors', async () => {
    const failedOutput = openAINativeFailureOutput('local_shell', 'critical update required', false)! as {
      output: string
    }
    const store = memoryStore()
    const wrapped = wrapOpenAIToolExecutions(
      { local_shell: openai.tools.localShell({ execute: async () => failedOutput }) },
      new OpenAIToolScheduler('c1'),
      scope,
      store
    )

    await expect(
      wrapped.local_shell.execute!({ action: { type: 'exec', command: ['true'] } }, options('call-failed'))
    ).resolves.toEqual(failedOutput)
    expect(store.rows.get('c1:call-failed')).toMatchObject({ status: 'error', output: failedOutput })
  })

  it('rejects call ID reuse with different inputs', async () => {
    const execute = vi.fn(async () => 'done')
    const wrapped = wrapOpenAIToolExecutions(mutationTool(execute), new OpenAIToolScheduler('c1'), scope, memoryStore())
    await wrapped.edit.execute!({ path: 'a.ts', value: 'one' }, options('call-1'))

    await expect(wrapped.edit.execute!({ path: 'a.ts', value: 'two' }, options('call-1'))).rejects.toMatchObject({
      code: 'input-mismatch',
    } satisfies Partial<OpenAIToolReplayError>)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('marks running checkpoints uncertain without repeating mutations', async () => {
    const execute = vi.fn(async () => 'should not run')
    const store = memoryStore()
    const input = { path: 'a.ts', value: 'one' }
    store.put({
      conversationId: 'c1',
      messageId: 'message-1',
      callId: 'call-1',
      toolName: 'edit',
      inputHash: hashOpenAIToolInput(input),
      status: 'running',
    })
    const wrapped = wrapOpenAIToolExecutions(mutationTool(execute), new OpenAIToolScheduler('c1'), scope, store)

    await expect(wrapped.edit.execute!(input, options('call-1'))).rejects.toMatchObject({
      code: 'uncertain-execution',
    } satisfies Partial<OpenAIToolReplayError>)
    expect(execute).not.toHaveBeenCalled()
    expect(store.rows.get('c1:call-1')?.status).toBe('uncertain')
  })

  it('recovers durable outputs after crashes before tool-result events', async () => {
    const execute = vi.fn(async () => ({ changed: true }))
    const store = memoryStore()
    const input = { path: 'a.ts', value: 'next' }
    const wrapped = wrapOpenAIToolExecutions(mutationTool(execute), new OpenAIToolScheduler('c1'), scope, store)

    // Mutations persisted before streams crashed without tool-result delivery.
    await wrapped.edit.execute!(input, options('call-crash'))
    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-crash', toolName: 'edit', input },
    ])

    const recovered = reconcileOpenAIToolExecutions(interrupted, scope, store)
    const replay = replayOpenAIResponsesLedger(recovered.ledger)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(recovered.recovered).toEqual([{ callId: 'call-crash', status: 'completed' }])
    expect(replay.lossless).toBe(true)
    expect(replay.messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-crash' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-crash',
            output: { type: 'json', value: { changed: true } },
          },
        ],
      },
    ])
    expect(reconcileOpenAIToolExecutions(recovered.ledger, scope, store).recovered).toEqual([])
  })

  it('checkpoints host mutations for lossless replay without reexecution', async () => {
    const execute = vi.fn(async () => ({ moved: true }))
    const store = memoryStore()
    const wrapped = wrapOpenAIToolExecutions(
      {
        notes_write_page: tool({
          description: 'Write a notes page.',
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute,
        }),
      },
      new OpenAIToolScheduler('c1'),
      scope,
      store
    )
    const input = { page: 'decisions' }

    await wrapped.notes_write_page.execute!(input, options('call-write'))
    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-write', toolName: 'notes_write_page', input },
    ])

    const recovered = reconcileOpenAIToolExecutions(interrupted, scope, store)
    const replay = replayOpenAIResponsesLedger(recovered.ledger)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(recovered.recovered).toEqual([{ callId: 'call-write', status: 'completed' }])
    expect(replay.lossless).toBe(true)
    expect(replay.messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-write' }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', output: { type: 'json', value: { moved: true } } }],
      },
    ])
  })

  it('closes interrupted read-only calls without checkpoints', () => {
    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-read', toolName: 'read', input: { path: 'README.md' } },
      { type: 'finish-step', finishReason: 'other' },
    ])

    const recovered = reconcileOpenAIToolExecutions(interrupted, scope, memoryStore())
    const replay = replayOpenAIResponsesLedger(recovered.ledger)

    expect(recovered.recovered).toEqual([{ callId: 'call-read', status: 'missing' }])
    expect(replay).toMatchObject({ lossless: true, issues: [] })
    expect(replay.messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-read' }] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-read',
            output: { type: 'error-text', value: expect.stringContaining('Treat it as failed') },
          },
        ],
      },
    ])
    expect(recovered.ledger.entries.map((entry) => entry.type)).toEqual(['tool-call', 'tool-result', 'step-boundary'])
  })

  it('rejects other-message outputs and synthesizes current-call failures', () => {
    const store = memoryStore()
    const input = { path: 'a.ts', value: 'next' }
    store.put({
      conversationId: 'c1',
      messageId: 'previous-message',
      callId: 'reused-call',
      toolName: 'edit',
      inputHash: hashOpenAIToolInput(input),
      status: 'completed',
      output: { changed: true },
    })
    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'reused-call', toolName: 'edit', input },
    ])

    const recovered = reconcileOpenAIToolExecutions(interrupted, scope, store)
    expect(recovered.recovered).toEqual([{ callId: 'reused-call', status: 'missing' }])
    expect(replayOpenAIResponsesLedger(recovered.ledger).messages).toMatchObject([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'reused-call' }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', output: { type: 'error-text' } }],
      },
    ])
    expect(JSON.stringify(recovered.ledger)).not.toContain('changed')
  })

  it('recovers enriched descriptions after crashes', async () => {
    const store = memoryStore()
    const baseOutput = {
      text: 'Screenshot captured.',
      images: [{ id: 'tool-image:exec-shot', mediaType: 'image/png', byteSize: 10 }],
    }
    const enrichedOutput = {
      ...baseOutput,
      images: [
        {
          ...baseOutput.images[0],
          description: 'Terminal screenshot: ENOENT error on line 3.',
          descriptionModel: 'vision-model',
        },
      ],
    }
    const input = { path: 'shot.png' }

    // Execution persisted without descriptions under optimistic vision metadata.
    const execute = vi.fn(async () => baseOutput)
    const wrapped = wrapOpenAIToolExecutions(
      {
        screenshot: tool({
          metadata: { parallelSafe: true },
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute,
        }),
      },
      new OpenAIToolScheduler('c1'),
      scope,
      store
    )
    await wrapped.screenshot.execute!(input, options('call-shot'))
    expect(JSON.stringify(store.rows.get('c1:call-shot')?.output)).not.toContain('Terminal screenshot')

    // Apply canonical enrichment to durable checkpoints.
    patchOpenAIToolExecutionOutputs(scope, [{ toolCallId: 'call-shot', output: enrichedOutput }], store)
    expect(JSON.stringify(store.rows.get('c1:call-shot')?.output)).toContain('Terminal screenshot')

    // Crash recovery rehydrates checkpoint descriptions for image-free replay.
    const interrupted = captureOpenAIResponsesStream([
      { type: 'tool-call', toolCallId: 'call-shot', toolName: 'screenshot', input },
    ])
    const recovered = reconcileOpenAIToolExecutions(interrupted, scope, store)
    expect(recovered.recovered).toEqual([{ callId: 'call-shot', status: 'completed' }])
    const serialized = JSON.stringify(replayOpenAIResponsesLedger(recovered.ledger, { dropImages: true }).messages)
    expect(serialized).toContain('Terminal screenshot')
    expect(serialized).not.toContain('omitted')

    // Unchanged or unrelated calls do not rewrite checkpoints.
    const before = JSON.stringify(store.rows.get('c1:call-shot')?.output)
    patchOpenAIToolExecutionOutputs(scope, [{ toolCallId: 'call-shot', output: enrichedOutput }], store)
    expect(JSON.stringify(store.rows.get('c1:call-shot')?.output)).toBe(before)
    patchOpenAIToolExecutionOutputs(scope, [{ toolCallId: 'call-other', output: enrichedOutput }], store)
    expect(JSON.stringify(store.rows.get('c1:call-shot')?.output)).toBe(before)
  })

  it('adds descriptions without reverting newer execution output', async () => {
    const store = memoryStore()
    const baseImage = { id: 'tool-image:exec-shot', mediaType: 'image/png', byteSize: 10 }
    const newerOutput = {
      text: 'Screenshot AFTER retry: pipeline verde.',
      images: [baseImage],
      structuredContent: { status: 'ok', attempts: 2 },
      isError: true,
    }
    // Stale snapshots contain old text but valid same-image descriptions.
    const enrichedOutput = {
      text: 'Screenshot captured.',
      images: [
        {
          ...baseImage,
          description: 'Terminal screenshot: ENOENT error on line 3.',
          descriptionModel: 'vision-model',
        },
      ],
    }

    // Current checkpoints already contain newer completed tool state.
    const execute = vi.fn(async () => newerOutput)
    const wrapped = wrapOpenAIToolExecutions(
      {
        screenshot: tool({
          metadata: { parallelSafe: true },
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute,
        }),
      },
      new OpenAIToolScheduler('c1'),
      scope,
      store
    )
    await wrapped.screenshot.execute!({ path: 'shot.png' }, options('call-shot'))

    patchOpenAIToolExecutionOutputs(scope, [{ toolCallId: 'call-shot', output: enrichedOutput }], store)
    const patched = store.rows.get('c1:call-shot')!.output as {
      text: string
      structuredContent?: unknown
      isError?: boolean
      images: Array<{ id: string; description?: string; descriptionModel?: string }>
    }
    expect(patched.text).toBe('Screenshot AFTER retry: pipeline verde.')
    expect(patched.structuredContent).toEqual({ status: 'ok', attempts: 2 })
    expect(patched.isError).toBe(true)
    expect(patched.images[0]?.id).toBe(baseImage.id)
    expect(patched.images[0]?.description).toBe('Terminal screenshot: ENOENT error on line 3.')
    expect(patched.images[0]?.descriptionModel).toBe('vision-model')
  })
})
