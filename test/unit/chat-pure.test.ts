import { describe, it, expect, vi } from 'vitest'
import {
  applyChatEvent,
  buildProviderOptions,
  buildProviderOptionsForSentEffort,
  contextOccupancy,
  costOfUsage,
  estimatedCostOfUsage,
  estimatedCostOfUsageWithSubagents,
  hasUsagePricing,
  isMaestrlyUltraEffort,
  MAESTRLY_ULTRA_EFFORT,
  reasoningPickerUltraState,
  resolveUltraEffort,
  totalTokensOf,
  usageMetaForModel,
  type ChatMessage,
} from '../../src/shared/chat'
import {
  activeChatContext,
  canReplayPersistedReasoning,
  clipMiddle,
  clipPersistedToolOutput,
  MAX_PERSISTED_TOOL_OUTPUT_CHARS,
  parseParts,
  renderTranscript,
  toModelMessages,
  withAnthropicCacheControl,
} from '../../src/main/chat/message'
import { mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'
import { formatResponseDuration, responseDurationMs } from '../../src/shared/response-duration'
import { wildcardMatch } from '../../src/main/chat/permission'
import {
  ALL_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  builtinToolNamesForMode,
  isOptInToolName,
} from '../../src/main/chat/tools'
import type { StoredChatMessage } from '../../src/main/chat/chat-store'

function userMsg(text: string): StoredChatMessage {
  return { id: 'u1', conversationId: 'c1', role: 'user', parts: [{ type: 'text', id: 't', text }], createdAt: 1 }
}

describe('applyChatEvent (fold reusado main+renderer)', () => {
  it('creates assistants and accumulates text deltas', () => {
    let msgs: ChatMessage[] = [userMsg('hi')]
    msgs = applyChatEvent(msgs, { kind: 'message-start', messageId: 'a1', createdAt: 2, responseStartedAt: 1 })
    msgs = applyChatEvent(msgs, { kind: 'text-start', messageId: 'a1', partId: 'x' })
    msgs = applyChatEvent(msgs, { kind: 'text-delta', messageId: 'a1', partId: 'x', delta: 'Hello' })
    msgs = applyChatEvent(msgs, { kind: 'text-delta', messageId: 'a1', partId: 'x', delta: ', world' })
    expect(msgs).toHaveLength(2)
    const a = msgs[1]
    expect(a.role).toBe('assistant')
    expect(a.responseStartedAt).toBe(1)
    expect(a.parts).toEqual([{ type: 'text', id: 'x', text: 'Hello, world' }])
  })

  it('hydrates live timers in SQLite placeholders', () => {
    const initial: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 2 }]
    const out = applyChatEvent(initial, {
      kind: 'message-start',
      messageId: 'a1',
      createdAt: 2,
      responseStartedAt: 1,
    })
    expect(out[0].responseStartedAt).toBe(1)
  })

  it('opens text parts lazily when text-start is missing', () => {
    let msgs: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1 }]
    msgs = applyChatEvent(msgs, { kind: 'text-delta', messageId: 'a1', partId: 'x', delta: 'hi' })
    expect(msgs[0].parts).toEqual([{ type: 'text', id: 'x', text: 'hi' }])
  })

  it('preserves billable usage on abort and error', () => {
    const initial: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1 }]
    const usage = { input: 100, output: 20, contextInput: 90, cachedInput: 50, cacheCreate: 10 }
    const aborted = applyChatEvent(initial, {
      kind: 'aborted',
      messageId: 'a1',
      usage,
      responseDurationMs: 1_234,
    })
    expect(aborted[0]).toMatchObject({ finishReason: 'aborted', usage, responseDurationMs: 1_234 })
    const errored = applyChatEvent(initial, {
      kind: 'error',
      messageId: 'a1',
      message: 'boom',
      usage,
      responseDurationMs: 2_345,
    })
    expect(errored[0]).toMatchObject({ error: 'boom', usage, responseDurationMs: 2_345 })
  })

  it('folds a structured Claude authentication error and removes only its duplicate assistant text', () => {
    const diagnostic = 'OAuth token expired. Please authenticate again.'
    const initial: ChatMessage[] = [
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'x', text: diagnostic }],
        createdAt: 1,
      },
    ]
    const out = applyChatEvent(initial, {
      kind: 'error',
      messageId: 'a1',
      message: 'Claude authentication expired or became invalid. Sign in again to continue.',
      code: 'claude-authentication-required',
      removeAssistantText: true,
    })
    expect(out[0]).toMatchObject({
      errorCode: 'claude-authentication-required',
      parts: [],
    })
  })

  it('aborts unfinished tools while preserving completed tools', () => {
    const initial: ChatMessage[] = [
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            id: 'r',
            toolCallId: 'r',
            toolName: 'task',
            input: { agent: 'explore' },
            state: {
              status: 'running',
              output: 'called grep',
              sub: {
                profile: { version: 1, agentName: 'explore', effective: null, attempts: [] },
              },
            },
          },
          { type: 'tool', id: 'p', toolCallId: 'p', toolName: 'read', input: null, state: { status: 'pending' } },
          {
            type: 'tool',
            id: 'w',
            toolCallId: 'w',
            toolName: 'bash',
            input: null,
            state: { status: 'awaiting-permission' },
          },
          {
            type: 'tool',
            id: 'c',
            toolCallId: 'c',
            toolName: 'task',
            input: {},
            state: {
              status: 'completed',
              output: 'ok',
              sub: { inputTokens: 1000, outputTokens: 200, durationMs: 5000 },
            },
          },
        ],
        createdAt: 1,
      },
    ]
    const out = applyChatEvent(initial, { kind: 'aborted', messageId: 'a1' })[0]
    expect(out.parts.map((p) => (p.type === 'tool' ? p.state.status : p.type))).toEqual([
      'error',
      'error',
      'error',
      'completed',
    ])
    const running = out.parts[0]
    expect(running.type === 'tool' && running.state.status === 'error' && running.state.error).toBe('Aborted')
    expect(running.type === 'tool' && running.state.status === 'error' && running.state.sub?.profile?.agentName).toBe(
      'explore'
    )
    // Completed output and subagent metrics remain intact.
    const done = out.parts[3]
    expect(done.type === 'tool' && done.state.status === 'completed' && done.state.output).toBe('ok')
    expect(done.type === 'tool' && done.state.status === 'completed' && done.state.sub).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      durationMs: 5000,
    })
  })

  it('records intra-turn compaction boundaries and usage without duplicate events', () => {
    const initial: ChatMessage[] = [
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 'old', text: 'prefix' }],
        createdAt: 1,
      },
    ]
    const usage = { usageVersion: 2 as const, input: 100, output: 20, contextInput: 90, contextOutput: 10 }
    const event = { kind: 'compaction' as const, messageId: 'a1', partId: 'cmp', text: 'summary', usage }
    const once = applyChatEvent(initial, event)
    const twice = applyChatEvent(once, event)
    expect(twice[0].parts).toEqual([
      { type: 'text', id: 'old', text: 'prefix' },
      { type: 'compaction', id: 'cmp', text: 'summary' },
    ])
    expect(twice[0].usage).toEqual(usage)
  })

  it('transitions tools from pending through running to completed', () => {
    let msgs: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1 }]
    msgs = applyChatEvent(msgs, { kind: 'tool-input-start', messageId: 'a1', toolCallId: 'k', toolName: 'read' })
    msgs = applyChatEvent(msgs, {
      kind: 'tool-call',
      messageId: 'a1',
      toolCallId: 'k',
      toolName: 'read',
      input: { path: 'a.ts' },
    })
    msgs = applyChatEvent(msgs, { kind: 'tool-state', messageId: 'a1', toolCallId: 'k', state: { status: 'running' } })
    msgs = applyChatEvent(msgs, {
      kind: 'tool-state',
      messageId: 'a1',
      toolCallId: 'k',
      state: { status: 'completed', output: 'content' },
    })
    const tool = msgs[0].parts[0]
    expect(tool.type).toBe('tool')
    if (tool.type === 'tool') {
      expect(tool.toolName).toBe('read')
      expect(tool.input).toEqual({ path: 'a.ts' })
      expect(tool.state).toEqual({ status: 'completed', output: 'content' })
    }
  })

  it('returns immutable arrays and objects', () => {
    const before: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1 }]
    const after = applyChatEvent(before, { kind: 'text-delta', messageId: 'a1', partId: 'x', delta: 'hi' })
    expect(after).not.toBe(before)
    expect(after[0]).not.toBe(before[0])
    expect(before[0].parts).toHaveLength(0) // original intacto
  })

  it('adds generated-image handles idempotently by part ID', () => {
    let msgs: ChatMessage[] = [{ id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1 }]
    msgs = applyChatEvent(msgs, {
      kind: 'generated-image',
      messageId: 'a1',
      partId: 'item_img',
      artifactId: 'deadbeef',
      name: 'robot.png',
      mediaType: 'image/png',
      revisedPrompt: 'a robot',
      byteSize: 128,
    })
    expect(msgs[0].parts).toEqual([
      {
        type: 'generated-image',
        id: 'item_img',
        artifactId: 'deadbeef',
        name: 'robot.png',
        mediaType: 'image/png',
        revisedPrompt: 'a robot',
        byteSize: 128,
      },
    ])

    // Replaying the same item replaces it without duplicate cards.
    msgs = applyChatEvent(msgs, {
      kind: 'generated-image',
      messageId: 'a1',
      partId: 'item_img',
      artifactId: 'cafe',
      name: 'robot.png',
      mediaType: 'image/png',
    })
    expect(msgs[0].parts).toHaveLength(1)
    expect(msgs[0].parts[0]).toEqual({
      type: 'generated-image',
      id: 'item_img',
      artifactId: 'cafe',
      name: 'robot.png',
      mediaType: 'image/png',
    })
  })

  it('freezes total duration and removes live timers on finish', () => {
    let msgs: ChatMessage[] = [
      { id: 'a1', conversationId: 'c1', role: 'assistant', parts: [], createdAt: 1, responseStartedAt: 100 },
    ]
    msgs = applyChatEvent(msgs, {
      kind: 'finish',
      messageId: 'a1',
      finishReason: 'stop',
      usage: { input: 10, output: 5 },
      responseDurationMs: 4_321,
    })
    expect(msgs[0]).toMatchObject({
      finishReason: 'stop',
      usage: { input: 10, output: 5 },
      responseDurationMs: 4_321,
    })
    expect(msgs[0].responseStartedAt).toBeUndefined()
  })
})

describe('response timing', () => {
  it('prevents negative durations and formats compactly', () => {
    expect(responseDurationMs(5_000, 4_000)).toBe(0)
    expect(responseDurationMs(1_000, 126_678)).toBe(125_678)
    expect(formatResponseDuration(8_900)).toBe('8s')
    expect(formatResponseDuration(125_678)).toBe('2m 05s')
    expect(formatResponseDuration(3_845_000)).toBe('1h 04m 05s')
  })
})

describe('toModelMessages (port of to-llm-message)', () => {
  it('maps user and text-only assistant roles', () => {
    const out = toModelMessages([
      userMsg('question'),
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', id: 't', text: 'answer' }],
        createdAt: 2,
      },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ])
  })

  it('expands slash-skill bodies before model text', () => {
    const out = toModelMessages([
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        createdAt: 1,
        parts: [
          {
            type: 'skill-invocation',
            id: 's1',
            name: 'deploy',
            args: 'prod',
            body: 'Skill "deploy" loaded.\nSkill directory: /tmp/skills/deploy\n\nSuba o ambiente.',
            dir: '/tmp/skills/deploy',
          },
          { type: 'text', id: 't', text: 'confira o checklist' },
        ],
      },
    ])
    expect(out).toEqual([
      {
        role: 'user',
        content:
          'Skill "deploy" loaded.\nSkill directory: /tmp/skills/deploy\n\nSuba o ambiente.\n\nconfira o checklist',
      },
    ])
  })

  it('assistant with a tool emits assistant tool-call followed by tool tool-result', () => {
    const out = toModelMessages([
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          {
            type: 'tool',
            id: 'k',
            toolCallId: 'k',
            toolName: 'read',
            input: { path: 'a' },
            state: { status: 'completed', output: 'X' },
          },
        ],
      },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'k', toolName: 'read' }],
    })
    expect(out[1]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'k', output: { type: 'text', value: 'X' } }],
    })
  })

  it('replays canonical image output according to vision support', () => {
    const canonical = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const output = {
      ...canonical,
      images: canonical.images?.map((image) => ({ ...image, description: 'A browser screenshot' })),
    }
    const history: StoredChatMessage[] = [
      userMsg('continue'),
      {
        id: 'a-tool-image',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          {
            type: 'tool',
            id: 'tool-image',
            toolCallId: 'tool-image',
            toolName: 'screenshot',
            input: {},
            state: { status: 'completed', output },
          },
        ],
      },
    ]

    const vision = toModelMessages(history)
    const visionOutput = (vision[2] as { role: 'tool'; content: Array<{ output: unknown }> }).content[0]?.output
    expect(visionOutput).toMatchObject({ type: 'content' })
    expect(JSON.stringify(visionOutput)).toContain('aGVsbG8=')

    const nonVision = toModelMessages(history, { dropImages: true })
    const nonVisionOutput = (nonVision[2] as { role: 'tool'; content: Array<{ output: unknown }> }).content[0]?.output
    expect(JSON.stringify(nonVisionOutput)).toContain('A browser screenshot')
    expect(JSON.stringify(nonVisionOutput)).not.toContain('aGVsbG8=')
    expect(JSON.stringify(nonVisionOutput)).not.toContain('"type":"file"')
  })

  it('omits undescribed images for consumers without vision', () => {
    const canonical = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
    const history: StoredChatMessage[] = [
      userMsg('continue'),
      {
        id: 'a-tool-image',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          {
            type: 'tool',
            id: 'tool-image',
            toolCallId: 'tool-image',
            toolName: 'screenshot',
            input: {},
            state: { status: 'completed', output: canonical },
          },
        ],
      },
    ]

    const dropped = toModelMessages(history, { dropImages: true })
    const droppedOutput = (dropped[2] as { role: 'tool'; content: Array<{ output: unknown }> }).content[0]?.output
    expect(JSON.stringify(droppedOutput)).toContain('omitted: the selected model does not accept images')
    expect(JSON.stringify(droppedOutput)).not.toContain('aGVsbG8=')
    expect(JSON.stringify(droppedOutput)).not.toContain('"type":"file"')
  })

  it('replays only generated-image text references without handles or bytes', () => {
    const out = toModelMessages([
      { id: 'u1', conversationId: 'c1', role: 'user', createdAt: 1, parts: [{ type: 'text', id: 't', text: 'gere' }] },
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          { type: 'text', id: 'tx', text: 'Here it is:' },
          {
            type: 'generated-image',
            id: 'item_img',
            artifactId: 'deadbeef',
            name: 'robot.png',
            mediaType: 'image/png',
            revisedPrompt: 'a teal robot',
            byteSize: 4096,
          },
        ],
      },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'gere' },
      { role: 'assistant', content: 'Here it is:[generated image: robot.png]\nrevised prompt: a teal robot' },
    ])
    // No image content parts: replaying generated pixels would charge vision every turn.
    expect(JSON.stringify(out)).not.toContain('"type":"image"')
    expect(JSON.stringify(out)).not.toContain('deadbeef')
  })

  it('synthesizes valid results for dangling tool calls on continuation', () => {
    // Transparent retries include partial assistants; interrupted tools
    // must become valid call/result pairs or providers reject continuation.
    const out = toModelMessages([
      { id: 'u1', conversationId: 'c1', role: 'user', createdAt: 1, parts: [{ type: 'text', id: 't', text: 'hi' }] },
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          { type: 'text', id: 'tx', text: 'I will read the file.' },
          {
            type: 'tool',
            id: 'k',
            toolCallId: 'k',
            toolName: 'read',
            input: { path: 'a' },
            state: { status: 'running' },
          },
        ],
      },
    ])
    // User, assistant text and call, then synthetic tool result.
    expect(out).toHaveLength(3)
    expect(out[1]).toMatchObject({ role: 'assistant' })
    expect(out[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'k', output: { type: 'text', value: '(the tool did not finish)' } }],
    })
  })

  it('preserves linear text-tool-text step boundaries', () => {
    const out = toModelMessages([
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          { type: 'text', id: 't1', text: 'vou ler' },
          {
            type: 'tool',
            id: 'k',
            toolCallId: 'k',
            toolName: 'read',
            input: {},
            state: { status: 'completed', output: 'R' },
          },
          { type: 'text', id: 't2', text: 'done' },
        ],
      },
    ])
    // assistant{text+toolcall} → tool{result} → assistant{text}
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(out[2]).toEqual({ role: 'assistant', content: 'done' })
  })

  it('maps user attachments to images and inline text', () => {
    const out = toModelMessages([
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        createdAt: 1,
        parts: [
          { type: 'text', id: 't', text: 'look at this' },
          {
            type: 'file',
            id: 'f1',
            name: 'foto.png',
            mediaType: 'image/png',
            kind: 'image',
            data: 'data:image/png;base64,AAA',
          },
          { type: 'file', id: 'f2', name: 'note.txt', mediaType: 'text/plain', kind: 'text', data: 'content' },
        ],
      },
    ])
    expect(out).toHaveLength(1)
    const content = out[0].content as Array<{ type: string; text?: string; image?: string | Uint8Array }>
    expect(content[0]).toEqual({ type: 'text', text: 'look at this' })
    expect(content[1].type).toBe('image')
    expect(Buffer.isBuffer(content[1].image)).toBe(true)
    expect(Buffer.from(content[1].image as Uint8Array).toString('base64')).toBe('AAA=')
    expect(content[2].type).toBe('text')
    expect(content[2].text).toContain('note.txt')
    expect(content[2].text).toContain('content')
  })

  it('replaces images with text notes for non-vision consumers', () => {
    const history = [
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user' as const,
        createdAt: 1,
        parts: [
          { type: 'text' as const, id: 't', text: 'look at this' },
          {
            type: 'file' as const,
            id: 'f1',
            name: 'foto.png',
            mediaType: 'image/png',
            kind: 'image' as const,
            data: 'data:image/png;base64,AAA',
          },
        ],
      },
    ]
    const dropped = toModelMessages(history, { dropImages: true })[0].content as Array<{ type: string; text?: string }>
    expect(dropped.some((c) => c.type === 'image')).toBe(false)
    const note = dropped.find((c) => c.type === 'text' && c.text?.includes('foto.png'))
    expect(note?.text).toContain('does not accept images')
    // Without image dropping, normal image replay is preserved.
    const kept = toModelMessages(history)[0].content as Array<{ type: string }>
    expect(kept.some((c) => c.type === 'image')).toBe(true)
  })

  it('sends interpreted image text to non-vision consumers', () => {
    const history = [
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user' as const,
        createdAt: 1,
        parts: [
          {
            type: 'file' as const,
            id: 'f1',
            name: 'foto.png',
            mediaType: 'image/png',
            kind: 'image' as const,
            data: 'data:image/png;base64,AAA',
            description: 'Terminal with an ENOENT error.',
            descriptionModel: 'Vision Co/gpt-vision',
          },
        ],
      },
    ]
    const dropped = toModelMessages(history, { dropImages: true })[0].content as Array<{
      type: string
      text?: string
    }>
    expect(dropped.some((c) => c.type === 'image')).toBe(false)
    const note = dropped.find((c) => c.type === 'text')
    expect(note?.text).toContain('Terminal with an ENOENT error.')
    expect(note?.text).toContain('Vision Co/gpt-vision')
    expect(note?.text).not.toContain('omitted')
    // Vision consumers still receive attachments; descriptions are fallback only.
    expect((toModelMessages(history)[0].content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(true)
    // Portable transcripts include descriptions for native seeds and compaction.
    expect(renderTranscript(history)).toContain('Terminal with an ENOENT error.')
    expect(renderTranscript(history)).toContain('Vision Co/gpt-vision')
  })

  it('replaces pre-compaction history with summary and suffix', () => {
    const out = toModelMessages([
      {
        id: 'u0',
        conversationId: 'c1',
        role: 'user',
        createdAt: 1,
        parts: [{ type: 'text', id: 't0', text: 'old message 1' }],
      },
      {
        id: 'a0',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [{ type: 'text', id: 'r0', text: 'answer old' }],
      },
      {
        id: 'k',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 3,
        parts: [{ type: 'compaction', id: 'cmp', text: 'SUMMARY of previous events' }],
      },
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        createdAt: 4,
        parts: [{ type: 'text', id: 't1', text: 'question new' }],
      },
    ])
    // Only the summary and new question reach the model.
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('assistant')
    expect(String(out[0].content)).toContain('SUMMARY of previous events')
    expect(out[0].content).not.toContain('old message')
    expect(out[1]).toEqual({ role: 'user', content: 'question new' })
  })

  it('discards same-message pre-compaction prefixes', () => {
    const history: ChatMessage[] = [
      {
        id: 'u0',
        conversationId: 'c1',
        role: 'user',
        createdAt: 1,
        parts: [{ type: 'text', id: 'u', text: 'request old' }],
      },
      {
        id: 'a0',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          { type: 'text', id: 'before', text: 'previously summarized prefix' },
          { type: 'compaction', id: 'cmp', text: 'INTRA-TURN SUMMARY' },
          { type: 'text', id: 'after', text: 'suffix that must survive' },
        ],
      },
    ]
    const out = toModelMessages(history)
    expect(out).toHaveLength(2)
    expect(String(out[0].content)).toContain('INTRA-TURN SUMMARY')
    expect(out[1]).toEqual({ role: 'assistant', content: 'suffix that must survive' })
    expect(JSON.stringify(out)).not.toContain('request old')
    expect(JSON.stringify(out)).not.toContain('previously summarized prefix')
  })

  it('uses the latest of two compactions and the final suffix', () => {
    const message: ChatMessage = {
      id: 'a0',
      conversationId: 'c1',
      role: 'assistant',
      createdAt: 1,
      parts: [
        { type: 'text', id: 'old', text: 'old' },
        { type: 'compaction', id: 'c1', text: 'SUMMARY 1' },
        { type: 'text', id: 'middle', text: 'middle' },
        { type: 'compaction', id: 'c2', text: 'SUMMARY 2' },
        { type: 'text', id: 'final', text: 'final' },
      ],
    }
    const active = activeChatContext([message])
    expect(active.summary).toBe('SUMMARY 2')
    expect(active.messages).toHaveLength(1)
    expect(active.messages[0].parts).toEqual([{ type: 'text', id: 'final', text: 'final' }])
    const serialized = JSON.stringify(toModelMessages([message]))
    expect(serialized).toContain('SUMMARY 2')
    expect(serialized).toContain('final')
    expect(serialized).not.toContain('SUMMARY 1')
    expect(serialized).not.toContain('middle')
    expect(serialized).not.toContain('old')
  })

  it('adds handoff context without clearing history', () => {
    const out = toModelMessages([
      {
        id: 'ctx',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 1,
        parts: [{ type: 'context', id: 'x', text: 'came from Claude', source: 'Claude Code' }],
      },
      {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        createdAt: 2,
        parts: [{ type: 'text', id: 't', text: 'continua' }],
      },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('assistant')
    expect(String(out[0].content)).toContain('Claude Code')
    expect(String(out[0].content)).toContain('came from Claude')
    expect(out[1]).toEqual({ role: 'user', content: 'continua' })
  })

  it('sets cache anchors on the first and last two messages only when enabled', () => {
    const history = [
      userMsg('a'),
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, id: 't1', text: 'x' }],
        createdAt: 2,
      },
      userMsg('b'),
      {
        id: 'a2',
        conversationId: 'c1',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, id: 't2', text: 'y' }],
        createdAt: 4,
      },
    ]
    const bp = { anthropic: { cacheControl: { type: 'ephemeral' } } }
    const out = toModelMessages(history, { cacheControl: true })
    // Four messages place anchors on first and final two entries.
    expect(out[0].providerOptions).toEqual(bp)
    expect(out[2].providerOptions).toEqual(bp)
    expect(out[3].providerOptions).toEqual(bp)
    expect(out[1].providerOptions).toBeUndefined()
    expect(toModelMessages(history).every((m) => m.providerOptions === undefined)).toBe(true) // Without the flag.
  })

  it('recalculates Anthropic cache markers without accumulating old marks', () => {
    const bp = { anthropic: { cacheControl: { type: 'ephemeral' } } }
    const first = withAnthropicCacheControl([{ role: 'user', content: 'task' }])
    const second = withAnthropicCacheControl([
      ...first,
      { role: 'assistant', content: 'partial 1' },
      { role: 'assistant', content: 'partial 2' },
      { role: 'assistant', content: 'partial 3' },
    ])
    expect(second.map((message) => message.providerOptions)).toEqual([bp, undefined, bp, bp])
  })

  it('maps failed and denied tools to transport errors', () => {
    const out = toModelMessages([
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          {
            type: 'tool',
            id: 'e',
            toolCallId: 'e',
            toolName: 'bash',
            input: {},
            state: { status: 'error', error: 'boom' },
          },
          {
            type: 'tool',
            id: 'd',
            toolCallId: 'd',
            toolName: 'edit',
            input: {},
            state: { status: 'denied', reason: 'no' },
          },
        ],
      },
    ])
    const toolMsg = out.find((m) => m.role === 'tool')!
    const content = toolMsg.content as Array<{ output: { type: string } }>
    expect(content[0].output.type).toBe('error-text')
    expect(content[1].output.type).toBe('execution-denied')
  })

  it('keeps nonempty reasoning in the correct assistant step', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r1', text: 'I will read the file.' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: { path: 'a' },
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(out[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'I will read the file.' },
        { type: 'tool-call', toolCallId: 'k', toolName: 'read' },
      ],
    })
    // The adapter materializes the field from providerOptions (getOpenAIMetadata).
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: 'I will read the file.' } })
    expect(out[2].role).toBe('tool')
  })

  it('preserves explicitly empty reasoning_content', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r1', text: '' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
    expect(out[1].content).toContainEqual({ type: 'reasoning', text: '' })
  })

  it('keeps alternating reasoning and tool values separate', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r1', text: 'R1' },
            {
              type: 'tool',
              id: 'k1',
              toolCallId: 'k1',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
            { type: 'reasoning', id: 'r2', text: 'R2' },
            {
              type: 'tool',
              id: 'k2',
              toolCallId: 'k2',
              toolName: 'edit',
              input: {},
              state: { status: 'completed', output: 'Y' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    const assistants = out.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0].providerOptions).toEqual({ openaiCompatible: { reasoning_content: 'R1' } })
    expect(assistants[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: 'R2' } })
    expect(assistants[0].content).toContainEqual({ type: 'reasoning', text: 'R1' })
    expect(assistants[1].content).toContainEqual({ type: 'reasoning', text: 'R2' })
  })

  it('reasoningReplay: text after a tool result opens a new assistant step without inheriting reasoning', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r1', text: 'R1' },
            {
              type: 'tool',
              id: 'k1',
              toolCallId: 'k1',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
            { type: 'text', id: 't1', text: 'after' },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    const assistants = out.filter((m) => m.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0].providerOptions).toEqual({ openaiCompatible: { reasoning_content: 'R1' } })
    // Subsequent plain-text steps do not inherit reasoning provider options.
    expect(assistants[1].content).toBe('after')
    expect(assistants[1].providerOptions).toBeUndefined()
  })

  it('discards reasoning when replay is disabled', () => {
    const history: ChatMessage[] = [
      userMsg('hi'),
      {
        id: 'a1',
        conversationId: 'c1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          { type: 'reasoning', id: 'r1', text: 'R1' },
          {
            type: 'tool',
            id: 'k',
            toolCallId: 'k',
            toolName: 'read',
            input: {},
            state: { status: 'completed', output: 'X' },
          },
        ],
      },
    ]
    const out = toModelMessages(history)
    expect(out[1].providerOptions).toBeUndefined()
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
  })

  it('does not resurrect reasoning discarded by compaction', () => {
    const out = toModelMessages(
      [
        {
          id: 'a0',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 1,
          parts: [
            { type: 'reasoning', id: 'r0', text: 'R0-discarded' },
            {
              type: 'tool',
              id: 'k0',
              toolCallId: 'k0',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
        {
          id: 'c1',
          conversationId: 'c1',
          role: 'user',
          createdAt: 3,
          parts: [{ type: 'compaction', id: 'cc', text: 'summary' }],
        },
        userMsg('continua'),
        {
          id: 'a2',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 4,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r2', text: 'R2' },
            {
              type: 'tool',
              id: 'k2',
              toolCallId: 'k2',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'Y' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('R0-discarded')
    expect(serialized).toContain('R2')
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: 'Summary of the conversation so far (compacted context):\n\nsummary',
    })
  })

  it('replays exact reasoning for matching provenance', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r1', text: 'R1' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(out[1].content).toContainEqual({ type: 'reasoning', text: 'R1' })
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: 'R1' } })
  })

  it('blocks cross-provider reasoning and uses empty tool-step fallback', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'anthropic', modelId: 'claude-4' },
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Claude reasoning' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    // Foreign reasoning does NOT appear in content (even as a part);
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
    // Tool steps preserve backend structure with empty fallback.
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })

  it('blocks reasoning replay across model changes', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Flash reasoning' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })

  it('uses empty reasoning fallback for legacy messages without model identity', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Legacy reasoning' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })

  it('replays current-turn reasoning alongside foreign history', () => {
    // History combines foreign Claude messages with the matching current partial turn.
    const out = toModelMessages(
      [
        userMsg('first'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'anthropic', modelId: 'claude-4' },
          parts: [
            { type: 'reasoning', id: 'r0', text: 'R-Claude' },
            {
              type: 'tool',
              id: 'k0',
              toolCallId: 'k0',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
        userMsg('continua'),
        {
          id: 'a2',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 4,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r2', text: 'R-DeepSeek' },
            {
              type: 'tool',
              id: 'k2',
              toolCallId: 'k2',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'Y' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    const assistants = out.filter((m) => m.role === 'assistant')
    // Foreign steps receive empty fallback without reasoning content.
    expect(JSON.stringify(assistants[0].content)).not.toContain('reasoning')
    expect(assistants[0].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
    // Current turn step: normal replay.
    expect(assistants[1].content).toContainEqual({ type: 'reasoning', text: 'R-DeepSeek' })
    expect(assistants[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: 'R-DeepSeek' } })
  })

  it('blocks reasoning when endpoint or credential fingerprints differ', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: 'fp_A',
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Old backend reasoning' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_B',
        },
      }
    )
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })

  it('does not rehydrate reasoning without legacy fingerprints', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Legacy reasoning' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })

  it('treats empty or corrupt fingerprints as absent', () => {
    const out = toModelMessages(
      [
        userMsg('hi'),
        {
          id: 'a1',
          conversationId: 'c1',
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
          providerFingerprint: '',
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Corrupt reasoning' },
            {
              type: 'tool',
              id: 'k',
              toolCallId: 'k',
              toolName: 'read',
              input: {},
              state: { status: 'completed', output: 'X' },
            },
          ],
        },
      ],
      {
        reasoningReplay: {
          field: 'reasoning_content',
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          providerFingerprint: 'fp_A',
        },
      }
    )
    expect(JSON.stringify(out[1].content)).not.toContain('reasoning')
    expect(out[1].providerOptions).toEqual({ openaiCompatible: { reasoning_content: '' } })
  })

  it('aggregates provenance matches and degradation reasons', () => {
    const stats = {
      replayedSteps: 0,
      degradedProviderMismatch: 0,
      degradedModelMismatch: 0,
      degradedFingerprintMissing: 0,
      degradedFingerprintMismatch: 0,
    }
    const policy = {
      field: 'reasoning_content',
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      providerFingerprint: 'fp_A',
    }
    const assistantWith = (overrides: Partial<StoredChatMessage>): StoredChatMessage => ({
      id: `a-${Math.random()}`,
      conversationId: 'c1',
      role: 'assistant',
      createdAt: 2,
      parts: [
        { type: 'reasoning', id: 'r', text: 'R' },
        {
          type: 'tool',
          id: 'k',
          toolCallId: 'k',
          toolName: 'read',
          input: {},
          state: { status: 'completed', output: 'X' },
        },
      ],
      ...overrides,
    })
    toModelMessages(
      [
        userMsg('hi'),
        // provider estrangeiro.
        assistantWith({ model: { providerId: 'anthropic', modelId: 'claude-4' } }),
        // Legacy entry without model.
        assistantWith({}),
        // Same origin.
        assistantWith({ model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, providerFingerprint: 'fp_A' }),
        // Missing fingerprint (valid model, no fingerprint).
        assistantWith({ model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' } }),
        // fingerprint divergente (backend trocado).
        assistantWith({ model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, providerFingerprint: 'fp_B' }),
        // Same provider, different model.
        assistantWith({ model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }, providerFingerprint: 'fp_A' }),
      ],
      { reasoningReplay: policy, replayStats: stats }
    )
    expect(stats).toEqual({
      replayedSteps: 1,
      degradedProviderMismatch: 2, // anthropic + legacy entry without model
      degradedModelMismatch: 1,
      degradedFingerprintMissing: 1,
      degradedFingerprintMismatch: 1,
    })
  })

  it('canReplayPersistedReasoning: igualdade TRIPLA (providerId, modelId, providerFingerprint)', () => {
    const policy = { providerId: 'deepseek', modelId: 'deepseek-v4-pro', providerFingerprint: 'fp_A' }
    const msg = (overrides: Partial<StoredChatMessage>): Pick<StoredChatMessage, 'model' | 'providerFingerprint'> => ({
      model: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      providerFingerprint: 'fp_A',
      ...overrides,
    })
    // All three identity axes match, allowing replay.
    expect(canReplayPersistedReasoning(msg({}), policy)).toBe(true)
    // Different provider returns false.
    expect(
      canReplayPersistedReasoning(msg({ model: { providerId: 'anthropic', modelId: 'deepseek-v4-pro' } }), policy)
    ).toBe(false)
    // Different model returns false.
    expect(
      canReplayPersistedReasoning(msg({ model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' } }), policy)
    ).toBe(false)
    // Different fingerprint returns false.
    expect(canReplayPersistedReasoning(msg({ providerFingerprint: 'fp_B' }), policy)).toBe(false)
    // Message without fingerprint: false.
    expect(canReplayPersistedReasoning(msg({ providerFingerprint: undefined }), policy)).toBe(false)
    // Empty or corrupt fingerprint returns false.
    expect(canReplayPersistedReasoning(msg({ providerFingerprint: '' }), policy)).toBe(false)
    // Legacy message without model: false.
    expect(canReplayPersistedReasoning({}, policy)).toBe(false)
  })

  it('Anthropic cache-control coexists with providerOptions from another namespace (openaiCompatible)', () => {
    const withBoth = withAnthropicCacheControl([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'k', toolName: 'read', input: {} }],
        providerOptions: { openaiCompatible: { reasoning_content: 'R1' } },
      },
    ])
    expect(withBoth[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
      openaiCompatible: { reasoning_content: 'R1' },
    })
  })
})

describe('usage and cost (Usage & Costs panel)', () => {
  const meta = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3 } // ~Opus: input $3, output $15, cache_read $0.30

  it('sums four disjoint usage buckets', () => {
    expect(totalTokensOf({ input: 100, output: 50, cacheRead: 80, cacheCreate: 20 })).toBe(250)
    expect(totalTokensOf({ input: -1, output: 5, cacheRead: 99, cacheCreate: 99 })).toBe(203)
  })

  it('without cache: cost equals input times input rate plus output times output rate', () => {
    const c = costOfUsage({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 }, meta)
    expect(c).toBeCloseTo(3 + 15, 6) // $18
  })

  it('charges cache reads at cache-read prices', () => {
    const c = costOfUsage({ input: 200_000, output: 0, cacheRead: 800_000, cacheCreate: 0 }, meta)
    expect(c).toBeCloseTo((200_000 * 3 + 800_000 * 0.3) / 1e6, 6) // 0.6 + 0.24 = 0.84
  })

  it('uses actual cache-write prices when available', () => {
    const c = costOfUsage(
      { input: 0, output: 0, cacheRead: 0, cacheCreate: 1_000_000 },
      { ...meta, cacheWritePer1M: 3.75 }
    )
    expect(c).toBeCloseTo(3.75, 6)
  })

  it('falls back to 1.25 times input price for cache creation', () => {
    const c = costOfUsage({ input: 0, output: 0, cacheRead: 0, cacheCreate: 1_000_000 }, meta)
    expect(c).toBeCloseTo(3 * 1.25, 6) // $3.75 (fallback)
  })

  it('charges buckets once and sanitizes negative values', () => {
    const priced = { ...meta, cacheWritePer1M: 3.75 }
    const mixed = costOfUsage({ input: 100_000, output: 0, cacheRead: 600_000, cacheCreate: 300_000 }, priced)
    expect(mixed).toBeCloseTo((100_000 * 3 + 600_000 * 0.3 + 300_000 * 3.75) / 1e6, 6)

    const sane = costOfUsage({ input: -1, output: -10, cacheRead: 800_000, cacheCreate: 200_000 }, priced)
    expect(sane).toBeCloseTo((800_000 * 0.3 + 200_000 * 3.75) / 1e6, 6)
  })

  it('returns zero cost without catalog prices', () => {
    expect(costOfUsage({ input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 }, null)).toBe(0)
    expect(costOfUsage({ input: 1e6, output: 1e6, cacheRead: 0, cacheCreate: 0 }, {})).toBe(0)
  })

  it('combines native and catalog cost without partial totals', () => {
    const total = { input: 1_000_000, output: 100_000 }
    const catalog = { input: 200_000, output: 10_000 }
    expect(estimatedCostOfUsage(total, meta, 0.5, catalog)).toBeCloseTo(0.5 + (200_000 * 3 + 10_000 * 15) / 1e6, 6)
    expect(estimatedCostOfUsage(total, null, 0.5, catalog)).toBeNull()
    expect(estimatedCostOfUsage(total, { inputPer1M: 3 }, 0.5, catalog)).toBeNull()
    expect(
      estimatedCostOfUsage({ input: 0, output: 0, cacheRead: 10, cacheCreate: 10 }, { inputPer1M: 3 })
    ).toBeCloseTo((10 * 3 + 10 * 3.75) / 1e6, 10)
    expect(estimatedCostOfUsage(total, null, 0, { input: 0, output: 0 })).toBe(0)
    expect(estimatedCostOfUsage(total, null)).toBeNull()
  })

  it('recognizes explicit zero and cache-only prices', () => {
    expect(hasUsagePricing({ inputPer1M: 0 })).toBe(true)
    expect(hasUsagePricing({ cacheReadPer1M: 0.3 })).toBe(true)
    expect(hasUsagePricing({ cacheWritePer1M: 3.75 })).toBe(true)
    expect(hasUsagePricing({ inputPer1M: Number.NaN })).toBe(false)
    expect(hasUsagePricing({})).toBe(false)
    expect(hasUsagePricing(null)).toBe(false)
  })

  it('does not reprice unknown historical metadata using the current model', () => {
    const current = { providerId: 'current-p', modelId: 'current-m', meta: { inputPer1M: 99 } }
    expect(usageMetaForModel({ 'old-p\0old-m': null }, { providerId: 'old-p', modelId: 'old-m' }, current)).toBeNull()
    expect(usageMetaForModel({}, { providerId: 'old-p', modelId: 'old-m' }, current)).toBeNull()
    expect(usageMetaForModel({}, { providerId: 'current-p', modelId: 'current-m' }, current)).toBe(current.meta)

    const exact = { inputPer1M: 1 }
    const legacy = { inputPer1M: 2 }
    expect(
      usageMetaForModel({ 'old-p\0old-m': exact, 'old-m': legacy }, { providerId: 'old-p', modelId: 'old-m' }, current)
    ).toBe(exact)
    expect(usageMetaForModel({ 'old-m': legacy }, { providerId: 'old-p', modelId: 'old-m' }, current)).toBe(legacy)
  })

  it('prices parent and subagent slices using their actual model metadata', () => {
    const parent = { providerId: 'claude', modelId: 'opus' }
    const sub = { providerId: 'openai', modelId: 'gpt-mini' }
    const metas = new Map<string, { inputPer1M: number; outputPer1M: number }>([
      ['claude\0opus', { inputPer1M: 3, outputPer1M: 15 }],
      ['openai\0gpt-mini', { inputPer1M: 1, outputPer1M: 4 }],
    ])
    const resolve = vi.fn((providerId: string, modelId: string) => metas.get(`${providerId}\0${modelId}`) ?? null)

    // Parent and subagent native estimates add directly without catalog lookup.
    const bothRuntime = estimatedCostOfUsageWithSubagents(
      {
        input: 100_000,
        output: 10_000,
        runtimeEstimatedCostUsd: 1.2,
        subagentUsage: [{ ...sub, input: 50_000, output: 5_000, runtimeEstimatedCostUsd: 0.3 }],
      },
      parent,
      resolve
    )
    expect(bothRuntime).toBeCloseTo(1.5, 6)
    expect(resolve).not.toHaveBeenCalled() // No slice needed catalog pricing.

    // Subagents without native estimates use their own model catalog.
    resolve.mockClear()
    const subCatalog = estimatedCostOfUsageWithSubagents(
      {
        input: 100_000,
        output: 10_000,
        runtimeEstimatedCostUsd: 1.2,
        subagentUsage: [{ ...sub, input: 1_000_000, output: 500_000 }],
      },
      parent,
      resolve
    )
    expect(subCatalog).toBeCloseTo(1.2 + (1_000_000 * 1 + 500_000 * 4) / 1e6, 6) // + $3.00
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('openai', 'gpt-mini')

    // Without native estimates, each model prices its own token buckets.
    resolve.mockClear()
    const allCatalog = estimatedCostOfUsageWithSubagents(
      {
        input: 200_000,
        output: 20_000,
        subagentUsage: [{ ...sub, input: 1_000_000, output: 500_000 }],
      },
      parent,
      resolve
    )
    expect(allCatalog).toBeCloseTo((200_000 * 3 + 20_000 * 15) / 1e6 + (1_000_000 * 1 + 500_000 * 4) / 1e6, 6)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('adds auxiliary compaction catalog buckets to parent runtime cost', () => {
    const parent = { providerId: 'claude', modelId: 'opus' }
    const resolve = vi.fn(() => ({ inputPer1M: 3, outputPer1M: 15 }))
    const cost = estimatedCostOfUsageWithSubagents(
      {
        input: 100_000,
        output: 10_000,
        runtimeEstimatedCostUsd: 1.2,
        // Auxiliary compaction uses the parent model catalog when native estimates are absent.
        catalogInput: 200_000,
        catalogOutput: 20_000,
        catalogCacheRead: 5_000,
        catalogCacheCreate: 1_000,
      },
      parent,
      resolve
    )
    expect(cost).toBeCloseTo(1.2 + (200_000 * 3 + 20_000 * 15 + 5_000 * 3 + 1_000 * 3.75) / 1e6, 6)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('claude', 'opus')
    // No catalog buckets means runtime-only cost without lookup.
    resolve.mockClear()
    expect(
      estimatedCostOfUsageWithSubagents({ input: 0, output: 0, runtimeEstimatedCostUsd: 0.9 }, parent, resolve)
    ).toBe(0.9)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('turn cost with subagents mixes runtime and catalog in one slice and legacy residual in the parent', () => {
    const parent = { providerId: 'claude', modelId: 'opus' }
    const sub = { providerId: 'openai', modelId: 'gpt-mini' }
    const meta = { inputPer1M: 3, outputPer1M: 15 }
    const resolve = () => meta

    // Mixed subagent executions separate native coverage from catalog residuals.
    const mixed = estimatedCostOfUsageWithSubagents(
      {
        input: 0,
        output: 0,
        runtimeEstimatedCostUsd: 0.5,
        subagentUsage: [
          { ...sub, input: 0, output: 0, runtimeEstimatedCostUsd: 0.2, catalogInput: 100_000, catalogOutput: 10_000 },
        ],
      },
      parent,
      resolve
    )
    expect(mixed).toBeCloseTo(0.5 + 0.2 + (100_000 * 3 + 10_000 * 15) / 1e6, 6)

    // Legacy envelope without breakdown: residual sub* totals use the PARENT model.
    const residual = estimatedCostOfUsageWithSubagents(
      { input: 100_000, output: 10_000, subInput: 200_000, subOutput: 30_000 },
      parent,
      resolve
    )
    expect(residual).toBeCloseTo((100_000 * 3 + 10_000 * 15 + 200_000 * 3 + 30_000 * 15) / 1e6, 6)
  })

  it('rejects partial cost totals and ignores unidentified slices', () => {
    const parent = { providerId: 'claude', modelId: 'opus' }

    // Missing both native and catalog prices yields null rather than partial totals.
    const unpricable = estimatedCostOfUsageWithSubagents(
      {
        input: 100_000,
        output: 10_000,
        runtimeEstimatedCostUsd: 1.2,
        subagentUsage: [{ providerId: 'unknown', modelId: 'x', input: 500_000, output: 50_000 }],
      },
      parent,
      () => null
    )
    expect(unpricable).toBeNull()

    // Without a parent model there is no parent or residual pricing: null.
    expect(
      estimatedCostOfUsageWithSubagents({ input: 100, output: 10 }, null, () => ({ inputPer1M: 1, outputPer1M: 1 }))
    ).toBeNull()

    // Invalid breakdown entries do not break valid entries.
    const skipInvalid = estimatedCostOfUsageWithSubagents(
      {
        input: 100_000,
        output: 10_000,
        runtimeEstimatedCostUsd: 1.2,
        subagentUsage: [
          { providerId: '', modelId: '', input: 999_999, output: 999_999 },
          { providerId: 'openai', modelId: 'gpt-mini', input: 0, output: 0, runtimeEstimatedCostUsd: 0.05 },
        ],
      },
      parent,
      () => ({ inputPer1M: 1, outputPer1M: 4 })
    )
    expect(skipInvalid).toBeCloseTo(1.25, 6)
  })
})

describe('buildProviderOptions (providerOptions by kind)', () => {
  const reasoningMeta = { reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
  const noReasoningMeta = { reasoning: false }

  it('openai-responses: always sets base store:false and include, even with reasoning off or no metadata', () => {
    expect(buildProviderOptions('openai-responses', 'off', reasoningMeta)).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    })
    expect(buildProviderOptions('openai-responses', undefined, null)).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    })
    // Model without reasoning: still includes base options, but no effort/summary.
    expect(buildProviderOptions('openai-responses', 'high', noReasoningMeta)).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    })
  })

  it('adds valid Responses effort and automatic summaries', () => {
    expect(buildProviderOptions('openai-responses', 'high', reasoningMeta)).toEqual({
      openai: {
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      },
    })
  })

  it('openai-responses: ULTRA maps to the highest model effort', () => {
    expect(buildProviderOptions('openai-responses', MAESTRLY_ULTRA_EFFORT, reasoningMeta)).toEqual({
      openai: {
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoningEffort: 'max',
        reasoningSummary: 'auto',
      },
    })
  })

  it('preserves native Ultra without activating Maestrly orchestration', () => {
    const nativeUltraMeta = { reasoning: true, reasoningEfforts: ['low', 'high', 'max', 'ultra'] }
    expect(isMaestrlyUltraEffort('ultra', nativeUltraMeta.reasoningEfforts)).toBe(false)
    expect(buildProviderOptions('openai-responses', 'ultra', nativeUltraMeta)).toEqual({
      openai: {
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoningEffort: 'ultra',
        reasoningSummary: 'auto',
      },
    })
  })

  it('recognizes legacy raw Ultra only when unadvertised by the model', () => {
    expect(isMaestrlyUltraEffort('ultra', ['low', 'high', 'max'])).toBe(true)
    expect(isMaestrlyUltraEffort('ultra', ['low', 'high', 'ultra'])).toBe(false)
    expect(isMaestrlyUltraEffort(MAESTRLY_ULTRA_EFFORT, ['ultra'])).toBe(true)
  })

  it('deduplicates orchestrated native Ultra picker cards', () => {
    expect(reasoningPickerUltraState(['low', 'max', 'ultra'], true)).toEqual({
      regularEfforts: ['low', 'max'],
      ultraValue: 'ultra',
      unifiedNativeUltra: true,
    })
    expect(reasoningPickerUltraState(['low', 'max', 'ultra'], false)).toEqual({
      regularEfforts: ['low', 'max', 'ultra'],
      ultraValue: MAESTRLY_ULTRA_EFFORT,
      unifiedNativeUltra: false,
    })
  })

  it('omits Responses efforts outside the model list', () => {
    expect(
      buildProviderOptions('openai-responses', 'xhigh', { reasoning: true, reasoningEfforts: ['low', 'medium'] })
    ).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    })
  })

  it('sends only valid Anthropic efforts', () => {
    expect(buildProviderOptions('anthropic', 'high', reasoningMeta)).toEqual({ anthropic: { effort: 'high' } })
    expect(buildProviderOptions('anthropic', 'off', reasoningMeta)).toBeUndefined()
    expect(buildProviderOptions('anthropic', 'high', noReasoningMeta)).toBeUndefined()
  })

  it('sends raw compatible efforts only when valid', () => {
    expect(buildProviderOptions('openai', 'medium', reasoningMeta)).toEqual({
      'openai-compatible': { reasoningEffort: 'medium' },
    })
    expect(buildProviderOptions('openai', 'off', reasoningMeta)).toBeUndefined()
    expect(buildProviderOptions('openai', undefined, reasoningMeta)).toBeUndefined()
  })

  it('lets Codex app-server govern reasoning options', () => {
    expect(buildProviderOptions('codex-subscription', 'high', reasoningMeta)).toBeUndefined()
  })

  it('uses default efforts when reasoning models omit levels', () => {
    // meta.reasoning=true without reasoningEfforts: accepts low/medium/high defaults, rejects xhigh.
    expect(buildProviderOptions('anthropic', 'medium', { reasoning: true })).toEqual({
      anthropic: { effort: 'medium' },
    })
    expect(buildProviderOptions('anthropic', 'xhigh', { reasoning: true })).toBeUndefined()
  })

  it('serializes validated efforts without local revalidation', () => {
    expect(buildProviderOptionsForSentEffort('openai', 'vendor-ultra')).toEqual({
      'openai-compatible': { reasoningEffort: 'vendor-ultra' },
    })
    expect(buildProviderOptionsForSentEffort('openai-responses', null)).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    })
  })
})

describe('parseParts (parse defensivo)', () => {
  it('returns empty parts for invalid JSON', () => {
    expect(parseParts('{nope')).toEqual([])
  })
  it('preserves valid parts and rejects invalid shapes', () => {
    expect(parseParts(JSON.stringify([{ type: 'text', id: 'a', text: 'hi' }]))).toEqual([
      { type: 'text', id: 'a', text: 'hi' },
    ])
    expect(parseParts(JSON.stringify([{ type: 'desconhecida' }]))).toEqual([])
  })

  it('discards invalid snapshots while preserving execution metrics', () => {
    const parsed = parseParts(
      JSON.stringify([
        {
          type: 'tool',
          id: 't',
          toolCallId: 't',
          toolName: 'task',
          input: {},
          state: {
            status: 'error',
            error: 'boom',
            sub: { profile: { version: 2, agentName: 'future' }, inputTokens: 10, durationMs: 50 },
          },
        },
      ])
    )
    expect(parsed[0]).toMatchObject({
      type: 'tool',
      state: { status: 'error', sub: { inputTokens: 10, durationMs: 50 } },
    })
    expect(parsed[0].type === 'tool' && 'sub' in parsed[0].state && parsed[0].state.sub?.profile).toBeUndefined()
  })

  it('preserves generated-image parts with valid handles', () => {
    const valid = {
      type: 'generated-image',
      id: 'item_img',
      artifactId: 'deadbeef',
      name: 'robot.png',
      mediaType: 'image/png',
      revisedPrompt: 'a robot',
      byteSize: 128,
    }
    expect(parseParts(JSON.stringify([valid]))).toEqual([valid])
    // Parts without artifact IDs cannot reference files and are discarded safely.
    expect(
      parseParts(JSON.stringify([{ type: 'generated-image', id: 'x', name: 'a.png', mediaType: 'image/png' }]))
    ).toEqual([])
  })

  it.each(['running', 'completed', 'error'] as const)('round-trips ToolState.%s.sub', (status) => {
    const state =
      status === 'running'
        ? { status, sub: { profile: { version: 1, agentName: 'explore', effective: null, attempts: [] } } }
        : status === 'completed'
          ? {
              status,
              output: 'ok',
              sub: { usage: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 }, durationMs: 5 },
            }
          : { status, error: 'boom', sub: { inputTokens: 10, outputTokens: 2, durationMs: 50 } }
    const parsed = parseParts(
      JSON.stringify([{ type: 'tool', id: 't', toolCallId: 't', toolName: 'task', input: {}, state }])
    )
    expect(parsed[0]).toMatchObject({ type: 'tool', state })
  })

  it('preserves attempted and effective Fast snapshots', () => {
    const profile = {
      version: 1,
      agentName: 'explore',
      effective: {
        providerId: 'codex',
        modelId: 'gpt-fast',
        configuredEffort: 'high',
        sentEffort: 'high',
        fastMode: true,
        source: 'conversation-default',
        candidateIndex: 0,
      },
      attempts: [
        {
          source: 'conversation-default',
          candidateIndex: 0,
          candidate: { providerId: 'codex', modelId: 'gpt-fast', effort: 'high', fastMode: true },
          outcome: 'selected',
          diagnostics: [],
        },
      ],
    }
    const parsed = parseParts(
      JSON.stringify([
        {
          type: 'tool',
          id: 't',
          toolCallId: 't',
          toolName: 'task',
          input: {},
          state: { status: 'running', sub: { profile } },
        },
      ])
    )
    expect(parsed[0]).toMatchObject({ type: 'tool', state: { sub: { profile } } })
  })

  it('round-trips Maestro profiles', () => {
    const profile = {
      version: 1,
      agentName: 'finalizer',
      category: 'delivery',
      effective: {
        providerId: 'builtin_codex_subscription',
        modelId: 'gpt-5.6-luna',
        configuredEffort: 'medium',
        sentEffort: 'medium',
        source: 'maestro-resource',
        ruleKey: 'finalizer',
        candidateIndex: 0,
      },
      attempts: [
        {
          source: 'maestro-resource',
          ruleKey: 'finalizer',
          candidateIndex: 0,
          candidate: {
            providerId: 'builtin_codex_subscription',
            modelId: 'gpt-5.6-luna',
            effort: 'medium',
          },
          outcome: 'selected',
          diagnostics: [],
        },
      ],
    }
    const parsed = parseParts(
      JSON.stringify([
        {
          type: 'tool',
          id: 't',
          toolCallId: 't',
          toolName: 'task',
          input: { agent: 'finalizer', prompt: 'Finalize the work.' },
          state: {
            status: 'completed',
            output: 'done',
            sub: {
              profile,
              startedAt: 500,
              usage: { input: 100, output: 20, cacheRead: 50, cacheCreate: 0 },
              durationMs: 1_000,
            },
          },
        },
      ])
    )

    expect(parsed[0]).toMatchObject({ type: 'tool', state: { sub: { profile, startedAt: 500 } } })
  })
})

describe('compaction transcript rendering', () => {
  it('labels roles and combines portable text and tool content', () => {
    const msgs: ChatMessage[] = [
      {
        id: 'u',
        conversationId: 'c',
        role: 'user',
        parts: [
          { type: 'text', id: 't', text: 'fix @store.ts' },
          {
            type: 'file',
            id: 'h',
            name: '@store.ts',
            mediaType: 'text/plain',
            kind: 'text',
            data: 'secret content',
            hidden: true,
          },
        ],
        createdAt: 1,
      },
      {
        id: 'a',
        conversationId: 'c',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            id: 'x',
            toolCallId: 'x',
            toolName: 'edit',
            input: {},
            state: { status: 'completed', output: 'ok' },
          },
          { type: 'text', id: 't2', text: 'done' },
        ],
        createdAt: 2,
      },
    ]
    const out = renderTranscript(msgs)
    expect(out).toContain('User: fix @store.ts')
    expect(out).toContain('[referenced content from @store.ts]\nsecret content')
    expect(out).toContain('Assistant:')
    expect(out).toContain('[tool edit → completed]')
    expect(out).toContain('input: {}')
    expect(out).toContain('output:\nok')
    expect(out).toContain('done')
  })

  it('includes generated images only as textual references', () => {
    const msgs: ChatMessage[] = [
      {
        id: 'a',
        conversationId: 'c',
        role: 'assistant',
        parts: [
          {
            type: 'generated-image',
            id: 'item_img',
            artifactId: 'deadbeef',
            name: 'robot.png',
            mediaType: 'image/png',
            revisedPrompt: 'a teal robot',
            byteSize: 4096,
          },
        ],
        createdAt: 1,
      },
    ]
    const out = renderTranscript(msgs)
    expect(out).toContain('[generated image: robot.png]')
    expect(out).toContain('revised prompt: a teal robot')
    expect(out).not.toContain('deadbeef') // The handle is a storage detail, not model context.
  })

  it('includes short skill references without reinjecting bodies', () => {
    const out = renderTranscript([
      {
        id: 'u',
        conversationId: 'c',
        role: 'user',
        createdAt: 1,
        parts: [
          {
            type: 'skill-invocation',
            id: 's',
            name: 'deploy',
            args: 'prod',
            body: 'HUGE SKILL INSTRUCTIONS',
          },
        ],
      },
    ])
    expect(out).toContain('[invoked skill /deploy prod]')
    expect(out).not.toContain('HUGE SKILL INSTRUCTIONS')
  })

  it('includes imported context after compaction boundaries', () => {
    const initial: ChatMessage[] = [
      {
        id: 'ctx',
        conversationId: 'c',
        role: 'assistant',
        parts: [{ type: 'context', id: 'import', text: 'critical handoff decision', source: 'Claude Code' }],
        createdAt: 1,
      },
    ]
    expect(renderTranscript(initial)).toContain('[imported context from Claude Code]\ncritical handoff decision')

    const afterMarker: ChatMessage[] = [
      {
        id: 'a',
        conversationId: 'c',
        role: 'assistant',
        parts: [
          { type: 'text', id: 'old', text: 'prefix old' },
          { type: 'compaction', id: 'cmp', text: 'summary current' },
          { type: 'context', id: 'new-import', text: 'new imported context', source: 'Codex' },
        ],
        createdAt: 2,
      },
    ]
    const transcript = renderTranscript(afterMarker)
    expect(transcript).toContain('Previous summary:\nsummary current')
    expect(transcript).toContain('[imported context from Codex]\nnew imported context')
    expect(transcript).not.toContain('prefix old')
  })

  it('includes necessary tool results within transcript limits', () => {
    const output = `HEAD-${'x'.repeat(20_000)}-TAIL`
    const msgs: ChatMessage[] = [
      {
        id: 'a',
        conversationId: 'c',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            id: 'tool',
            toolCallId: 'tool',
            toolName: 'read',
            input: { path: 'foo.ts' },
            state: { status: 'completed', output },
          },
        ],
        createdAt: 1,
      },
    ]
    const perTool = renderTranscript(msgs, { maxToolOutputChars: 200 })
    expect(perTool).toContain('[tool read → completed]')
    expect(perTool).toContain('HEAD-')
    expect(perTool).toContain('-TAIL')
    expect(perTool).toContain('tool output truncated for compaction')
    expect(perTool.length).toBeLessThan(300)

    const globallyClipped = renderTranscript(msgs, { maxToolOutputChars: 50_000, maxChars: 500 })
    expect(globallyClipped.length).toBeLessThanOrEqual(500)
    expect(globallyClipped).toContain('transcript middle omitted for compaction')
  })

  it('skips messages without a body', () => {
    const msgs: ChatMessage[] = [{ id: 'e', conversationId: 'c', role: 'assistant', parts: [], createdAt: 1 }]
    expect(renderTranscript(msgs)).toBe('')
  })

  it('recompacts the latest summary and suffix without old prefixes', () => {
    const msgs: ChatMessage[] = [
      {
        id: 'u',
        conversationId: 'c',
        role: 'user',
        parts: [{ type: 'text', id: 'old-u', text: 'request old' }],
        createdAt: 1,
      },
      {
        id: 'a',
        conversationId: 'c',
        role: 'assistant',
        parts: [
          { type: 'text', id: 'old-a', text: 'answer old' },
          { type: 'compaction', id: 'cmp', text: 'SUMMARY current' },
          { type: 'text', id: 'new-a', text: 'trabalho posterior' },
        ],
        createdAt: 2,
      },
    ]
    const out = renderTranscript(msgs)
    expect(out).toContain('Previous summary:\nSUMMARY current')
    expect(out).toContain('Assistant: trabalho posterior')
    expect(out).not.toContain('request old')
    expect(out).not.toContain('answer old')
  })
})

describe('persisted native tool output limits', () => {
  it('preserves outputs within limits', () => {
    const small = 'normal command output'
    expect(clipPersistedToolOutput(small)).toBe(small)
    const exact = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS)
    expect(clipPersistedToolOutput(exact)).toBe(exact)
  })

  it('caps huge outputs while preserving head and tail with a truncation marker', () => {
    const big = `HEAD-${'x'.repeat(1_200_000)}-TAIL`
    const clipped = clipPersistedToolOutput(big)
    expect(clipped.length).toBeLessThanOrEqual(MAX_PERSISTED_TOOL_OUTPUT_CHARS)
    expect(clipped.startsWith('HEAD-')).toBe(true)
    expect(clipped.endsWith('-TAIL')).toBe(true)
    expect(clipped).toContain('… output truncated …')
  })

  it('treats nonfinite clipping budgets as no-ops', () => {
    const text = 'y'.repeat(100_000)
    expect(clipMiddle(text, Number.POSITIVE_INFINITY, '…')).toBe(text)
  })
})

describe('READ_ONLY_TOOL_NAMES (Plan mode)', () => {
  it('excludes mutation tools while preserving reads', () => {
    expect(READ_ONLY_TOOL_NAMES).not.toContain('bash')
    expect(READ_ONLY_TOOL_NAMES).not.toContain('write')
    expect(READ_ONLY_TOOL_NAMES).not.toContain('edit')
    expect(READ_ONLY_TOOL_NAMES).not.toContain('review_plan') // review_plan is a Plan mode action, not a generic read-only tool.
    expect(READ_ONLY_TOOL_NAMES).toContain('read')
    expect(READ_ONLY_TOOL_NAMES).toContain('grep')
    expect(READ_ONLY_TOOL_NAMES.every((n) => ALL_TOOL_NAMES.includes(n))).toBe(true)
  })
})

describe('builtinToolNamesForMode (built-in tools by mode)', () => {
  it('gives Design the exact Agent built-in capability surface', () => {
    expect(builtinToolNamesForMode('design')).toEqual(builtinToolNamesForMode('agent'))
  })

  it('agent includes all tool classes except OPT-IN and internal-only capabilities', () => {
    const set = builtinToolNamesForMode('agent')
    expect([...set].sort()).toEqual([...ALL_TOOL_NAMES].filter((name) => !isOptInToolName(name)).sort())
    expect(set.has('bash')).toBe(true) // mutadora
    expect(set.has('todo_write')).toBe(true) // agent-only
    expect(set.has('read')).toBe(true) // read-only
    expect(set.has('review_plan')).toBe(true) // The plan action is also available in Agent mode.
    // The runner adds imagegen only when enabled and ChatGPT is connected.
    expect(set.has('generate_image')).toBe(false)
    expect(set.has('submit_review')).toBe(false)
  })
  it('limits Ask mode to read-only tools', () => {
    const set = builtinToolNamesForMode('ask')
    expect(set).toEqual(new Set(READ_ONLY_TOOL_NAMES))
    expect(set.has('read')).toBe(true)
    expect(set.has('grep')).toBe(true)
    expect(set.has('bash')).toBe(false)
    expect(set.has('write')).toBe(false)
    expect(set.has('edit')).toBe(false)
    expect(set.has('todo_write')).toBe(false)
    expect(set.has('review_plan')).toBe(false)
  })
  it('offers reads and review_plan in Plan mode without mutation tools', () => {
    const set = builtinToolNamesForMode('plan')
    expect(set).toEqual(new Set([...READ_ONLY_TOOL_NAMES, 'review_plan']))
    expect(set.has('read')).toBe(true)
    expect(set.has('review_plan')).toBe(true)
    expect(set.has('bash')).toBe(false)
    expect(set.has('write')).toBe(false)
    expect(set.has('edit')).toBe(false)
    expect(set.has('todo_write')).toBe(false)
  })

})

describe('wildcardMatch (port of util/wildcard)', () => {
  it('* matches everything; literals match exactly', () => {
    expect(wildcardMatch('bash', '*')).toBe(true)
    expect(wildcardMatch('bash', 'bash')).toBe(true)
    expect(wildcardMatch('bash', 'edit')).toBe(false)
  })
  it('*.env matches .env files', () => {
    expect(wildcardMatch('.env', '*.env')).toBe(true)
    expect(wildcardMatch('config/.env', '*.env')).toBe(true)
    expect(wildcardMatch('app.ts', '*.env')).toBe(false)
  })
  it('command prefix with trailing space (git *)', () => {
    expect(wildcardMatch('git status', 'git *')).toBe(true)
    expect(wildcardMatch('git', 'git *')).toBe(true) // " .*" → "( .*)?" makes the suffix optional.
  })
})

describe('shared context occupancy numerator', () => {
  it('uses final-step input and output instead of inflated multi-step totals', () => {
    // Many tool calls sum to 870k input, but final context is 95.4k plus 400 output.
    expect(contextOccupancy({ input: 870_000, output: 1_400, contextInput: 95_400, contextOutput: 400 })).toBe(95_800)
    // Legacy records without contextOutput preserve their original numerator.
    expect(contextOccupancy({ input: 870_000, output: 1_400, contextInput: 95_400 })).toBe(95_400)
    // Output-only final steps preserve zero context input rather than aggregate totals.
    expect(contextOccupancy({ usageVersion: 2, input: 10_000, output: 500, contextInput: 0, contextOutput: 50 })).toBe(
      50
    )
  })
  it('supports legacy and v2 context-usage fallbacks', () => {
    expect(contextOccupancy({ input: 1_000, output: 200 })).toBe(1_200)
    expect(contextOccupancy({ usageVersion: 2, input: 100, cachedInput: 800, cacheCreate: 100, output: 200 })).toBe(
      1_200
    )
  })
})

describe('Ultra resolution to the highest real model effort', () => {
  it('selects the highest canonical effort regardless of list order', () => {
    expect(resolveUltraEffort(['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
    expect(resolveUltraEffort(['max', 'low'])).toBe('max')
    expect(resolveUltraEffort(['none', 'low', 'medium', 'high', 'xhigh'])).toBe('xhigh')
    expect(resolveUltraEffort(['minimal', 'low', 'medium', 'high'])).toBe('high')
    expect(resolveUltraEffort(['low', 'max', 'ultra'])).toBe('ultra')
  })
  it('uses the last effort when no vocabulary is recognized', () => {
    expect(resolveUltraEffort(['turbo', 'mega', 'giga'])).toBe('giga')
  })
  it('ignores unknown efforts when recognized levels exist', () => {
    expect(resolveUltraEffort(['giga', 'medium', 'turbo'])).toBe('medium')
  })
  it('uses highest fallback effort for empty lists', () => {
    expect(resolveUltraEffort([])).toBe('high')
  })
})
