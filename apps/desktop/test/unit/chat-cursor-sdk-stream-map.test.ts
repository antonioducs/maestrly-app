import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@cursor/sdk'
import { createCursorStreamMapper, resolveCursorTerminalEvidence } from '../../src/main/chat/cursor-sdk/stream-map'
import { toolOutputImages, toolOutputText } from '../../src/shared/chat'
import { chatToolOutputToAiSdkOutput, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'

function kinds(events: { kind: string }[]): string[] {
  return events.map((e) => e.kind)
}

describe('createCursorStreamMapper', () => {
  it('maps system init metadata without emitting chat events', () => {
    const mapper = createCursorStreamMapper('m1')
    const events = mapper.push({
      type: 'system',
      subtype: 'init',
      agent_id: 'agent-1',
      run_id: 'run-1',
      model: { id: 'composer-2.5' },
      tools: ['shell', 'read', 'mcp'],
    } as SDKMessage)

    expect(events).toEqual([])
    expect(mapper.state()).toMatchObject({
      agentId: 'agent-1',
      runId: 'run-1',
      modelId: 'composer-2.5',
      tools: ['shell', 'read', 'mcp'],
      finished: false,
      openToolCallIds: [],
    })
  })

  it('maps assistant text and tool_use blocks', () => {
    const mapper = createCursorStreamMapper('m1')
    const events = mapper.push({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
    } as SDKMessage)

    expect(kinds(events)).toEqual(['text-start', 'text-delta', 'tool-input-start', 'tool-call', 'tool-state'])
    expect(events.find((e) => e.kind === 'text-delta')).toMatchObject({ delta: 'Hello' })
    expect(events.find((e) => e.kind === 'tool-call')).toMatchObject({
      toolCallId: 'call_1',
      toolName: 'read',
      input: { path: 'a.ts' },
    })
    expect(mapper.state().openToolCallIds).toEqual(['call_1'])
  })

  it('unwraps MCP envelope on tool_call into canonical toolName + flattened input', () => {
    const mapper = createCursorStreamMapper('m1')
    const events = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c-grep',
      name: 'mcp',
      status: 'running',
      args: {
        providerIdentifier: 'custom-user-tools',
        toolName: 'grep',
        args: { pattern: 'foo', include: '*.ts' },
      },
    } as SDKMessage)
    expect(events.find((e) => e.kind === 'tool-input-start')).toMatchObject({
      toolCallId: 'c-grep',
      toolName: 'grep',
    })
    expect(events.find((e) => e.kind === 'tool-call')).toMatchObject({
      toolCallId: 'c-grep',
      toolName: 'grep',
      input: { pattern: 'foo', include: '*.ts' },
    })
  })

  it('unwraps MCP envelope on assistant tool_use', () => {
    const mapper = createCursorStreamMapper('m1')
    const events = mapper.push({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_task',
            name: 'mcp',
            input: {
              providerIdentifier: 'custom-user-tools',
              toolName: 'task',
              args: { agent: 'explore', prompt: 'ache X' },
            },
          },
        ],
      },
    } as SDKMessage)
    expect(events.find((e) => e.kind === 'tool-call')).toMatchObject({
      toolCallId: 'call_task',
      toolName: 'task',
      input: { agent: 'explore', prompt: 'ache X' },
    })
  })

  it('keeps name mcp when there is no envelope', () => {
    const mapper = createCursorStreamMapper('m1')
    const events = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c-mcp',
      name: 'mcp',
      status: 'running',
      args: { command: 'ls' },
    } as SDKMessage)
    expect(events.find((e) => e.kind === 'tool-call')).toMatchObject({
      toolCallId: 'c-mcp',
      toolName: 'mcp',
      input: { command: 'ls' },
    })
  })

  it('promotes mcp to the nested name when the envelope arrives on a later fragment', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'late',
      name: 'mcp',
      status: 'running',
    } as SDKMessage)
    const later = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'late',
      name: 'mcp',
      status: 'running',
      args: {
        providerIdentifier: 'custom-user-tools',
        toolName: 'read',
        args: { path: 'a.ts' },
      },
    } as SDKMessage)
    expect(later.find((e) => e.kind === 'tool-call')).toMatchObject({
      toolCallId: 'late',
      toolName: 'read',
      input: { path: 'a.ts' },
    })
  })

  it('concatenates contiguous assistant fragments in one text part', () => {
    const mapper = createCursorStreamMapper('m1')
    const first = mapper.push({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Olá' }] },
    } as SDKMessage)
    const second = mapper.push({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'assistant', content: [{ type: 'text', text: ', mundo!' }] },
    } as SDKMessage)

    expect(kinds(first)).toEqual(['text-start', 'text-delta'])
    expect(kinds(second)).toEqual(['text-delta'])
    expect(first[0]).toMatchObject({ partId: 'cursor_text_0' })
    expect(first[1]).toMatchObject({ partId: 'cursor_text_0', delta: 'Olá' })
    expect(second[0]).toMatchObject({ partId: 'cursor_text_0', delta: ', mundo!' })
  })

  it('abre nova text part depois de tool para preservar a ordem visual', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Antes' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
        ],
      },
    } as SDKMessage)
    const after = mapper.push({
      type: 'assistant',
      agent_id: 'a',
      run_id: 'r',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Depois' }] },
    } as SDKMessage)

    expect(kinds(after)).toEqual(['text-start', 'text-delta'])
    expect(after).toEqual([
      { kind: 'text-start', messageId: 'm1', partId: 'cursor_text_1' },
      { kind: 'text-delta', messageId: 'm1', partId: 'cursor_text_1', delta: 'Depois' },
    ])
  })

  it('maps tool_call running → completed and redacts secrets in output', () => {
    const mapper = createCursorStreamMapper('m1')
    const running = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c1',
      name: 'shell',
      status: 'running',
      args: { command: 'echo hi' },
    } as SDKMessage)
    expect(kinds(running)).toEqual(['tool-input-start', 'tool-call', 'tool-state'])
    expect(mapper.state().openToolCallIds).toEqual(['c1'])

    const done = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c1',
      name: 'shell',
      status: 'completed',
      result: { text: 'Authorization: Bearer secret-token' },
    } as SDKMessage)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ kind: 'tool-state' })
    if (done[0]?.kind === 'tool-state' && done[0].state.status === 'completed') {
      expect(done[0].state.output).toContain('[REDACTED]')
      expect(done[0].state.output).not.toContain('secret-token')
    }
    expect(mapper.state().openToolCallIds).toEqual([])
  })

  it('maps tool_call error status', () => {
    const mapper = createCursorStreamMapper('m1')
    const events = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c2',
      name: 'edit',
      status: 'error',
      result: 'disk full',
    } as SDKMessage)
    const state = events.find((e) => e.kind === 'tool-state')
    expect(state).toMatchObject({
      kind: 'tool-state',
      state: { status: 'error', error: 'disk full' },
    })
    expect(mapper.state().openToolCallIds).toEqual([])
  })

  it('preserves a Cursor custom-tool image result as a multimodal tool state', () => {
    const mapper = createCursorStreamMapper('m1')
    const original = mcpResultToChatToolOutput({
      content: [
        { type: 'text', text: 'Screenshot captured.' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })
    const echoed = JSON.parse(JSON.stringify(chatToolOutputToAiSdkOutput(original)))
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'image-call',
      name: 'browser_screenshot',
      status: 'running',
      args: {},
    } as SDKMessage)
    const events = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'image-call',
      name: 'browser_screenshot',
      status: 'completed',
      result: echoed,
    } as SDKMessage)
    const state = events.find((event) => event.kind === 'tool-state')
    expect(state?.kind).toBe('tool-state')
    if (state?.kind === 'tool-state' && state.state.status === 'completed') {
      expect(toolOutputText(state.state.output)).toContain('Screenshot captured.')
      expect(toolOutputImages(state.state.output)).toHaveLength(1)
      expect(toolOutputImages(state.state.output)[0]?.id).toBe(toolOutputImages(original)[0]?.id)
      expect(JSON.stringify(state.state.output)).not.toContain('aGVsbG8=')
    }
  })

  it('clips completed tool output beyond 50k with a visible marker', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'big',
      name: 'shell',
      status: 'running',
      args: {},
    } as SDKMessage)
    const done = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'big',
      name: 'shell',
      status: 'completed',
      result: { text: 'y'.repeat(120_000) },
    } as SDKMessage)
    const state = done.find((e) => e.kind === 'tool-state')
    expect(state?.kind).toBe('tool-state')
    if (state?.kind === 'tool-state' && state.state.status === 'completed') {
      expect(toolOutputText(state.state.output).length).toBeLessThan(50_000 + 100)
      expect(toolOutputText(state.state.output)).toContain('output truncated')
    }
    expect(mapper.state().openToolCallIds).toEqual([])
  })

  it('clips tool output > 50k no status error', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'big-err',
      name: 'shell',
      status: 'running',
      args: {},
    } as SDKMessage)
    const done = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'big-err',
      name: 'shell',
      status: 'error',
      result: { text: 'e'.repeat(120_000) },
    } as SDKMessage)
    const state = done.find((e) => e.kind === 'tool-state')
    expect(state?.kind).toBe('tool-state')
    if (state?.kind === 'tool-state' && state.state.status === 'error') {
      expect(state.state.error.length).toBeLessThan(50_000 + 100)
      expect(state.state.error).toContain('output truncated')
    }
  })

  it('redacts before clipping so partial secrets cannot survive truncation', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'edge',
      name: 'shell',
      status: 'running',
      args: {},
    } as SDKMessage)
    // Position the secret across the clip boundary: clipping first would leak its suffix.
    const token = 'crsr_live_AbCdEf1234567890'
    const marker = '\n\n… output truncated …\n\n'
    const budget = 50_000 - marker.length
    const tailStart = 120_000 - (budget - Math.floor(budget / 4))
    const raw = 'x'.repeat(120_000)
    // Newlines provide word boundaries; the secret begins 15 characters before the cut.
    const withSecret = raw.slice(0, tailStart - 16) + `\n${token}\n` + raw.slice(tailStart - 15 + token.length)
    const tailFragment = token.slice(15)
    expect(tailFragment).toHaveLength(11)
    // Verify the fixture would expose the suffix if clipped before redaction.
    expect(withSecret.slice(tailStart)).toContain(tailFragment)

    const done = mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'edge',
      name: 'shell',
      status: 'completed',
      result: { text: withSecret },
    } as SDKMessage)
    const state = done.find((e) => e.kind === 'tool-state')
    expect(state?.kind).toBe('tool-state')
    if (state?.kind === 'tool-state' && state.state.status === 'completed') {
      // Neither the credential nor its suffix survives; the redaction marker remains.
      expect(state.state.output).not.toContain(tailFragment)
      expect(state.state.output).not.toContain('crsr_')
      expect(state.state.output).toContain('[REDACTED]')
      expect(state.state.output).toContain('output truncated')
    }
  })

  it('clips terminal details beyond 50k when reconciling open tools', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'open-big',
      name: 'shell',
      status: 'running',
      args: {},
    } as SDKMessage)
    const events = mapper.push({
      type: 'status',
      agent_id: 'a',
      run_id: 'r',
      status: 'ERROR',
      message: 'z'.repeat(120_000),
    } as SDKMessage)
    const state = events.find((e) => e.kind === 'tool-state')
    expect(state?.kind).toBe('tool-state')
    if (state?.kind === 'tool-state' && state.state.status === 'error') {
      expect(state.state.error.length).toBeLessThan(50_000 + 100)
      expect(state.state.error).toContain('output truncated')
    }
  })

  it('reconciles open tools on FINISHED without emitting terminal (runner decides)', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'open1',
      name: 'shell',
      status: 'running',
      args: {},
    } as SDKMessage)
    expect(mapper.state().openToolCallIds).toEqual(['open1'])

    const events = mapper.push({
      type: 'status',
      agent_id: 'a',
      run_id: 'r',
      status: 'FINISHED',
    } as SDKMessage)

    // Only the runner emits a terminal turn event; the mapper reconciles open tools.
    expect(kinds(events)).toEqual(['tool-state'])
    const toolState = events.find((e) => e.kind === 'tool-state')
    expect(toolState).toMatchObject({ kind: 'tool-state', toolCallId: 'open1' })
    if (toolState?.kind === 'tool-state') {
      expect(toolState.state.status).toBe('error')
      if (toolState.state.status === 'error') {
        expect(toolState.state.error).toMatch(/did not complete|incomplete stream/i)
      }
    }
    expect(mapper.state().openToolCallIds).toEqual([])
    expect(mapper.state().finished).toBe(true)
    expect(mapper.state().finishStatus).toBe('FINISHED')
  })

  it('reconciles open tools on ERROR with sanitized detail, no terminal event', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'open2',
      name: 'read',
      status: 'running',
    } as SDKMessage)

    const events = mapper.push({
      type: 'status',
      agent_id: 'a',
      run_id: 'r',
      status: 'ERROR',
      message: 'boom api_key=secret',
    } as SDKMessage)

    expect(kinds(events)).toEqual(['tool-state'])
    const toolState = events.find((e) => e.kind === 'tool-state')
    if (toolState?.kind === 'tool-state' && toolState.state.status === 'error') {
      expect(toolState.state.error).not.toContain('secret')
      expect(toolState.state.error).toContain('[REDACTED]')
    }
    expect(events.some((e) => e.kind === 'error' || e.kind === 'finish' || e.kind === 'aborted')).toBe(false)
    // Retain terminal details for the runner to produce its sanitized error.
    expect(mapper.state().finishStatus).toBe('ERROR')
    expect(mapper.state().finishMessage).toContain('boom')
    expect(mapper.state().openToolCallIds).toEqual([])
  })

  it('reconciles open tools on CANCELLED without emitting aborted', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'open3',
      name: 'mcp',
      status: 'running',
    } as SDKMessage)

    const events = mapper.push({
      type: 'status',
      agent_id: 'a',
      run_id: 'r',
      status: 'CANCELLED',
    } as SDKMessage)

    expect(kinds(events)).toEqual(['tool-state'])
    const toolState = events.find((e) => e.kind === 'tool-state')
    if (toolState?.kind === 'tool-state' && toolState.state.status === 'error') {
      expect(toolState.state.error).toMatch(/cancelled/i)
    }
    expect(events.some((e) => e.kind === 'error' || e.kind === 'finish' || e.kind === 'aborted')).toBe(false)
    expect(mapper.state().openToolCallIds).toEqual([])
  })

  it('does not duplicate terminal tool state after completed', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'tool_call',
      agent_id: 'a',
      run_id: 'r',
      call_id: 'c9',
      name: 'read',
      status: 'completed',
      result: 'ok',
    } as SDKMessage)
    const again = mapper.reconcileOpenTools('FINISHED')
    expect(again).toEqual([])
    expect(mapper.state().openToolCallIds).toEqual([])
  })

  it('maps thinking deltas and closes part when duration is present', () => {
    const mapper = createCursorStreamMapper('m1')
    const first = mapper.push({
      type: 'thinking',
      agent_id: 'a',
      run_id: 'r',
      text: 'step 1',
    } as SDKMessage)
    expect(kinds(first)).toEqual(['reasoning-start', 'reasoning-delta'])

    const terminal = mapper.push({
      type: 'thinking',
      agent_id: 'a',
      run_id: 'r',
      text: 'step 2',
      thinking_duration_ms: 12,
    } as SDKMessage)
    expect(kinds(terminal)).toEqual(['reasoning-delta'])

    const next = mapper.push({
      type: 'thinking',
      agent_id: 'a',
      run_id: 'r',
      text: 'new block',
    } as SDKMessage)
    expect(kinds(next)).toEqual(['reasoning-start', 'reasoning-delta'])
  })

  it('leaves unavailable or malformed usage unknown', () => {
    for (const usage of [{}, { inputTokens: 10 }, { inputTokens: NaN, outputTokens: 1 }]) {
      const mapper = createCursorStreamMapper('m1')
      mapper.push({ type: 'usage', agent_id: 'a', run_id: 'r', usage } as SDKMessage)
      expect(mapper.state().lastUsage).toBeNull()
    }
  })

  it('maps usage into ChatUsage v2 buckets', () => {
    const mapper = createCursorStreamMapper('m1')
    mapper.push({
      type: 'usage',
      agent_id: 'a',
      run_id: 'r',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 14,
      },
    } as SDKMessage)
    expect(mapper.state().lastUsage).toEqual({
      usageVersion: 2,
      input: 10,
      output: 4,
      cachedInput: 2,
      cacheCreate: 1,
    })
  })

  it('registers terminal status without emitting finish/error/aborted (runner decides UI terminal)', () => {
    const finished = createCursorStreamMapper('m1')
    expect(
      kinds(finished.push({ type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' } as SDKMessage))
    ).toEqual([])
    expect(finished.state().finished).toBe(true)
    expect(finished.state().finishStatus).toBe('FINISHED')

    const errored = createCursorStreamMapper('m2')
    const errEvents = errored.push({
      type: 'status',
      agent_id: 'a',
      run_id: 'r',
      status: 'ERROR',
      message: 'boom api_key=secret',
    } as SDKMessage)
    expect(errEvents.some((e) => e.kind === 'error' || e.kind === 'finish' || e.kind === 'aborted')).toBe(false)
    expect(errored.state().finished).toBe(true)
    expect(errored.state().finishStatus).toBe('ERROR')

    const cancelled = createCursorStreamMapper('m3')
    expect(
      kinds(cancelled.push({ type: 'status', agent_id: 'a', run_id: 'r', status: 'CANCELLED' } as SDKMessage))
    ).toEqual([])
    expect(cancelled.state().finishStatus).toBe('CANCELLED')
  })

  it('captures request_id from request messages for diagnostics', () => {
    const mapper = createCursorStreamMapper('m1')
    expect(mapper.push({ type: 'request', agent_id: 'a', run_id: 'r', request_id: 'req-1' } as SDKMessage)).toEqual([])
    expect(mapper.state().requestId).toBe('req-1')
    // Missing request_id is allowed.
    expect(createCursorStreamMapper('m2').state().requestId).toBeNull()
  })
})

describe('resolveCursorTerminalEvidence', () => {
  it.each([
    // stream, wait, expected status, expected conflict
    ['FINISHED', 'finished', 'FINISHED', false],
    ['FINISHED', undefined, 'FINISHED', false],
    ['FINISHED', 'error', 'ERROR', true],
    ['FINISHED', 'cancelled', 'CANCELLED', true],
    ['FINISHED', 'expired', 'EXPIRED', true],
    ['FINISHED', 'bogus-status', 'FINISHED', false],
    ['ERROR', 'finished', 'ERROR', true],
    ['ERROR', 'error', 'ERROR', false],
    ['ERROR', undefined, 'ERROR', false],
    ['CANCELLED', 'finished', 'CANCELLED', true],
    ['EXPIRED', 'cancelled', 'EXPIRED', false],
    [undefined, 'finished', 'FINISHED', false],
    [undefined, 'error', 'ERROR', false],
    [undefined, undefined, null, false],
    ['bogus-status', 'bogus-status', null, false],
    [null, 'unknown', null, false],
  ])('stream=%s wait=%s → status=%s conflict=%s', (stream, wait, status, conflict) => {
    expect(
      resolveCursorTerminalEvidence(stream as string | null | undefined, wait as string | null | undefined)
    ).toEqual({
      status,
      conflict,
    })
  })
})
