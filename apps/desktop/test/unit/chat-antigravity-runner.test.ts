import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ChatStreamEvent } from '../../src/shared/chat'

const h = vi.hoisted(() => ({ mcpTools: {} as Record<string, unknown> }))
vi.mock('../../src/main/chat/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/mcp')>()
  return {
    ...actual,
    buildMcpTools: vi.fn(async () => ({ tools: h.mcpTools, close: async () => undefined })),
  }
})

import { upsertChatMessage } from '../../src/main/chat/chat-store'
import { closeAntigravityHostMcpServer } from '../../src/main/chat/antigravity-subscription/host-mcp'
import type { AntigravitySubscriptionManager } from '../../src/main/chat/antigravity-subscription/manager'
import { antigravityTokenPath } from '../../src/main/chat/antigravity-subscription/paths'
import {
  type RunAntigravitySubscriptionChatArgs,
  runAntigravitySubscriptionChat,
} from '../../src/main/chat/antigravity-subscription/runner'
import { getAntigravitySessionBinding } from '../../src/main/chat/antigravity-subscription/session-store'
import { createFakeAntigravity, type FakeAntigravity } from '../helpers/antigravity-fake'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

const echo = tool({
  description: 'Echo text back.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => `echo:${text}`,
})

let fake: FakeAntigravity
let manager: AntigravitySubscriptionManager
let cwd: string
let conversationId: string
let userSeq = 0

beforeEach(async () => {
  freshDb()
  cwd = mkdtempSync(path.join(os.tmpdir(), 'maestrly-agy-runner-'))
  conversationId = makeConversation(makeWorkspace().id, { cwd }).id
  h.mcpTools = { echo }
  fake = createFakeAntigravity()
  manager = fake.manager()
  await manager.login()
})

afterEach(async () => {
  await fake.cleanup()
  await closeAntigravityHostMcpServer()
  closeDb()
  rmSync(cwd, { recursive: true, force: true })
})

async function turn(
  text: string,
  overrides: Partial<RunAntigravitySubscriptionChatArgs> = {},
  conversation = conversationId
): Promise<{ events: ChatStreamEvent[]; result: Awaited<ReturnType<typeof runAntigravitySubscriptionChat>> }> {
  const id = `user-${++userSeq}`
  upsertChatMessage({
    id,
    conversationId: conversation,
    role: 'user',
    parts: [{ type: 'text', id: `${id}-text`, text }],
    createdAt: Date.now(),
  } as never)
  const events: ChatStreamEvent[] = []
  const result = await runAntigravitySubscriptionChat({
    conversationId: conversation,
    projectId: null,
    cwd,
    selection: { providerId: 'builtin_antigravity_subscription', modelId: 'gemini-3.8-flash' },
    mode: 'agent',
    manager,
    accountIdentity: manager.getAccountIdentity(),
    broker: { assert: vi.fn(async () => undefined) } as never,
    questionBroker: { ask: vi.fn(async () => []) } as never,
    emit: (event) => events.push(event),
    signal: new AbortController().signal,
    canPersistSession: () => true,
    ...overrides,
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  return { events, result }
}

const textOf = (events: ChatStreamEvent[]) =>
  events.flatMap((event) => (event.kind === 'text-delta' ? [event.delta] : [])).join('')
const kinds = (events: ChatStreamEvent[]) => events.map((event) => event.kind)
const promptText = (entry: Record<string, unknown> | undefined) => {
  const params = entry?.params as { prompt?: Array<{ type: string; text?: string }> } | undefined
  return (params?.prompt ?? []).map((block) => block.text ?? '').join('\n')
}
const firstMcpUrl = (entry: Record<string, unknown> | undefined) => {
  const params = entry?.params as { mcpServers?: Array<{ url: string }> } | undefined
  return params?.mcpServers?.[0]?.url
}

describe('Antigravity chat runner', () => {
  it('starts a session with built-in tools disabled, the host MCP server, and the tool catalog', async () => {
    const { events, result } = await turn('ECHO oi')
    expect(kinds(events)[0]).toBe('message-start')
    expect(kinds(events)).toContain('text-start')
    expect(events.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'stop' })
    expect(textOf(events)).toBe('oi')

    const [created] = fake.requests('session/new').slice(-1)
    const params = created?.params as {
      cwd: string
      _meta: unknown
      mcpServers: Array<{ type: string; name: string; url: string }>
    }
    expect(params._meta).toEqual({ agy: { enabledTools: [] } })
    expect(params.mcpServers).toHaveLength(1)
    expect(params.mcpServers[0]).toMatchObject({ type: 'http', name: 'maestrly' })
    expect(params.cwd).toMatch(/[\\/]work$/)
    expect(params.cwd).not.toBe(cwd)
    const prompt = promptText(fake.requests('session/prompt').at(-1))
    expect(prompt).toContain('<maestrly_instructions>')
    expect(prompt).toContain('<maestrly_tools>')
    expect(prompt).toContain('- maestrly_echo: Echo text back.')
    expect(getAntigravitySessionBinding(conversationId)).toMatchObject({
      sessionId: result.sessionId,
      modelValue: 'gemini-3.8-flash-high',
    })
  })

  it('runs Maestrly tools through the host server with one tool call id', async () => {
    const { events } = await turn('TOOL echo {"text":"x"}')
    const start = events.find((event) => event.kind === 'tool-input-start')
    const call = events.find((event) => event.kind === 'tool-call')
    const state = events.find((event) => event.kind === 'tool-state')
    expect(start).toMatchObject({ toolName: 'echo' })
    expect(call).toMatchObject({ toolName: 'echo', input: { text: 'x' } })
    expect(state).toMatchObject({ state: { status: 'completed', output: 'echo:x' } })
    const ids = new Set([start, call, state].map((event) => (event as { toolCallId: string }).toolCallId))
    expect(ids.size).toBe(1)
    expect(textOf(events)).toBe('tool-result:echo:x')
    expect(events.at(-1)?.kind).toBe('finish')
  })

  it('reuses the live session on the next turn without resending the catalog', async () => {
    await turn('ECHO one')
    const { events } = await turn('ECHO two')
    expect(textOf(events)).toBe('two')
    expect(
      fake.requests('session/new').filter((entry) => (entry.params as { mcpServers: unknown[] }).mcpServers.length)
    ).toHaveLength(1)
    expect(fake.requests('session/resume')).toHaveLength(0)
    expect(promptText(fake.requests('session/prompt').at(-1))).toBe('ECHO two')
  })

  it('starts a new seeded session when the tool set changes', async () => {
    await turn('ECHO first answer')
    const firstSession = getAntigravitySessionBinding(conversationId)?.sessionId
    h.mcpTools = {
      echo,
      extra: tool({ description: 'Extra.', inputSchema: z.object({}), execute: async () => 'extra' }),
    }
    await turn('ECHO second')
    const sessions = fake
      .requests('session/new')
      .filter((entry) => (entry.params as { mcpServers: unknown[] }).mcpServers.length)
    expect(sessions).toHaveLength(2)
    const prompt = promptText(fake.requests('session/prompt').at(-1))
    expect(prompt).toContain('maestrly_extra')
    expect(prompt).toContain('first answer')
    expect(getAntigravitySessionBinding(conversationId)?.sessionId).not.toBe(firstSession)
    await expect
      .poll(() =>
        fake
          .requests('session/delete')
          .some((entry) => (entry.params as { sessionId: string }).sessionId === firstSession)
      )
      .toBe(true)
  })

  it('denies native Antigravity tool permission requests', async () => {
    const { events } = await turn('NATIVE')
    expect(textOf(events)).toBe('permission:deny')
  })

  it('cancels the ACP turn when Maestrly aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const { events } = await turn('SLOW', { signal: controller.signal })
    expect(events.at(-1)?.kind).toBe('aborted')
    expect(fake.requests('session/cancel')).toHaveLength(1)
    expect(getAntigravitySessionBinding(conversationId)).toBeUndefined()
  })

  it('reports a rejected sign-in and marks the account signed out', async () => {
    await manager.listModels()
    rmSync(antigravityTokenPath(manager.root))
    const { events } = await turn('ECHO hi')
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/sign-in is missing or expired/),
    })
    expect(manager.getStatus().state).toBe('signed-out')
  })

  it('fails the turn when the session never reached the host tools', async () => {
    const { events } = await turn('SKIPMCP')
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      removeAssistantText: true,
      message: expect.stringMatching(/could not connect to Maestrly's tools/),
    })
    expect(getAntigravitySessionBinding(conversationId)).toBeUndefined()
  })

  it('resumes the persisted session on a restarted process with a fresh tool server', async () => {
    await turn('ECHO before')
    const firstUrl = firstMcpUrl(fake.requests('session/new').at(-1))
    await (await manager.connection()).client.close(200)
    const { events } = await turn('ECHO after')
    expect(textOf(events)).toBe('after')
    const resumedUrl = firstMcpUrl(fake.requests('session/resume')[0])
    expect(firstUrl).toBeTruthy()
    expect(resumedUrl).toBeTruthy()
    expect(resumedUrl).not.toBe(firstUrl)
    const log = fake.log().map((entry) => entry.method)
    expect(log.lastIndexOf('session/set_config_option')).toBeGreaterThan(log.lastIndexOf('session/resume'))
    expect(promptText(fake.requests('session/prompt').at(-1))).toBe('ECHO after')
  })

  it('selects the ACP model variant for the requested effort', async () => {
    await turn('ECHO hi', {
      selection: { providerId: 'builtin_antigravity_subscription', modelId: 'gemini-3.1-pro' },
      reasoningEffort: 'low',
    })
    expect(fake.requests('session/set_config_option').at(-1)?.params).toMatchObject({
      configId: 'model',
      value: 'gemini-3.1-pro-low',
    })
  })

  it('reports an unknown model without starting a session', async () => {
    const { events } = await turn('ECHO hi', {
      selection: { providerId: 'builtin_antigravity_subscription', modelId: 'missing-model' },
    })
    expect(events.at(-1)).toMatchObject({ kind: 'error', message: expect.stringMatching(/missing-model/) })
    expect(fake.requests('session/prompt')).toHaveLength(0)
  })

  it('runs task delegations through the host subagent runtime with the authoritative terminal state', async () => {
    const runTask = vi.fn(
      async (_input: unknown, _id: string, _signal: AbortSignal, update: (state: object) => void) => {
        update({ sub: { profile: null, startedAt: 1 } })
        return { output: 'subagent report', sub: { profile: null, startedAt: 1, durationMs: 5 } }
      }
    )
    const first = await turn('ECHO warm-up')
    const catalog = promptText(fake.requests('session/prompt').at(-1))
    const agent = /"agent":\{"type":"string","enum":\["([^"]+)"/.exec(catalog)?.[1]
    expect(agent).toBeTruthy()
    expect(first.events.at(-1)?.kind).toBe('finish')
    const { events } = await turn(`TOOL task {"agent":"${agent}","prompt":"Investigate."}`, {
      runTask: runTask as never,
    })
    expect(runTask).toHaveBeenCalledWith(
      { agent, prompt: 'Investigate.' },
      expect.stringMatching(/^agy_/),
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(events.find((event) => event.kind === 'tool-state')).toMatchObject({
      state: { status: 'completed', output: 'subagent report', sub: { durationMs: 5 } },
    })
    expect(textOf(events)).toBe('tool-result:subagent report')
  })

  it('deletes an ACP session and its files from the account home', async () => {
    const { result } = await turn('ECHO bye')
    const sessionId = result.sessionId as string
    const meta = path.join(manager.root, '.gemini', 'antigravity-acp', 'conversations', `${sessionId}.meta`)
    expect(existsSync(meta)).toBe(true)
    await manager.deleteSession(sessionId)
    expect(existsSync(meta)).toBe(false)
    await manager.deleteSession('../../escape')
    expect(existsSync(manager.root)).toBe(true)
  })

  it('keeps a live session only after a finished turn', async () => {
    await turn('ECHO keep')
    expect(manager.liveSessionCount()).toBe(1)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await turn('SLOW', { signal: controller.signal })
    expect(manager.liveSessionCount()).toBe(0)
  })
})
