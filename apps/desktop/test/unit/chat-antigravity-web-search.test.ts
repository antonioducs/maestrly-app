import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAccountChangedError } from '../../src/main/chat/antigravity-subscription/errors'
import type { AntigravitySubscriptionManager } from '../../src/main/chat/antigravity-subscription/manager'
import { antigravityAcpHome } from '../../src/main/chat/antigravity-subscription/paths'
import {
  ANTIGRAVITY_SEARCH_SESSION_META,
  parseAntigravitySearchToolUpdate,
  searchWebWithAntigravityRuntime,
} from '../../src/main/chat/antigravity-subscription/web-search'
import { createFakeAntigravity, type FakeAntigravity } from '../helpers/antigravity-fake'

let fake: FakeAntigravity
let manager: AntigravitySubscriptionManager

beforeEach(async () => {
  fake = createFakeAntigravity()
  manager = fake.manager()
  await manager.login()
})
afterEach(async () => {
  await fake.cleanup()
})

function search(query: string, overrides: Partial<Parameters<typeof searchWebWithAntigravityRuntime>[0]> = {}) {
  return searchWebWithAntigravityRuntime({
    manager,
    accountIdentity: manager.getAccountIdentity(),
    query,
    signal: new AbortController().signal,
    ...overrides,
  })
}

/** Answers the client sent to the agent's `session/request_permission` requests, in order. */
function permissionAnswers(): unknown[] {
  return fake
    .log()
    .filter((entry) => typeof entry.id === 'string' && String(entry.id).startsWith('agent-') && 'result' in entry)
    .map((entry) => (entry.result as { outcome?: unknown }).outcome)
}

function promptedSessionId(): string {
  const params = fake.requests('session/prompt').at(-1)?.params as { sessionId?: string } | undefined
  return params?.sessionId ?? ''
}

const GROUNDED = (call: number, query: string) =>
  [
    `Result ${call} for **${query}**[1].`,
    '',
    'Sources:',
    '[1] [docs.example.test](https://vertexaisearch.cloud.google.com/grounding-api-redirect/FAKE_SOURCE_1)',
  ].join('\n')

describe('Antigravity web search', () => {
  it('searches in a session that enables only search_web and returns the grounded answer', async () => {
    const started = Date.now()
    const result = await search('SEARCH electron vibrancy')

    expect(result).toEqual({ text: GROUNDED(1, 'electron vibrancy') })
    expect(fake.requests('session/new').at(-1)?.params).toMatchObject({
      mcpServers: [],
      _meta: ANTIGRAVITY_SEARCH_SESSION_META,
    })
    expect(fake.requests('session/set_config_option').at(-1)?.params).toMatchObject({ value: 'gemini-3.8-flash-low' })
    expect(permissionAnswers()).toEqual([{ outcome: 'selected', optionId: 'allow' }])
    // The model's restatement of the result is cut short instead of waited for.
    await expect.poll(() => fake.requests('session/cancel').length).toBe(1)
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('puts a multi-line query on the last line of the prompt, on one line', async () => {
    await search('SEARCH electron\n\nvibrancy')
    const prompt = fake.requests('session/prompt').at(-1)?.params as { prompt: { text: string }[] }
    expect(prompt.prompt[0].text.split('\n').at(-1)).toBe('SEARCH electron vibrancy')
  })

  it('removes the session files', async () => {
    await search('SEARCH electron vibrancy')
    const id = promptedSessionId()
    await expect.poll(() => fake.requests('session/delete').length).toBe(1)
    await expect.poll(() => existsSync(path.join(antigravityAcpHome(manager.root), 'brain', id))).toBe(false)
  })

  it('approves one search per session and rejects a second call', async () => {
    const result = await search('SEARCH2 electron vibrancy')
    expect(result.text).toBe(GROUNDED(1, 'electron vibrancy'))
    await expect.poll(() => permissionAnswers().length).toBe(2)
    expect(permissionAnswers()).toEqual([
      { outcome: 'selected', optionId: 'allow' },
      { outcome: 'selected', optionId: 'deny' },
    ])
  })

  it('reports what the model said when it did not search', async () => {
    await expect(search('ECHO I already know that')).rejects.toThrow(
      'Google AI did not run a web search. It answered: I already know that'
    )
  })

  it('turns an exhausted quota into a hint to pick another provider', async () => {
    await expect(search('SEARCHFAIL electron vibrancy')).rejects.toThrow(
      /Google AI web search limit reached.*another web search provider/
    )
  })

  it('cancels the turn when aborted', async () => {
    const controller = new AbortController()
    const pending = search('SLOW', { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('stop')
    try {
      await vi.waitFor(() => expect(fake.requests('session/prompt')).toHaveLength(1))
    } finally {
      controller.abort(new Error('stop'))
      await rejected
    }
    await expect.poll(() => fake.requests('session/cancel').length).toBe(1)
  })

  it('refuses to search for another account identity', async () => {
    await expect(search('SEARCH x', { accountIdentity: { fingerprint: 'project:other', epoch: 1 } })).rejects.toThrow(
      new AntigravityAccountChangedError().message
    )
    expect(fake.requests('session/new')).toHaveLength(0)
  })
})

describe('Antigravity search tool updates', () => {
  it('reads the grounded answer of a completed call from rawOutput, then from its text content', () => {
    expect(
      parseAntigravitySearchToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'completed',
        rawOutput: ' Answer[1].\n\nSources:\n[1] [a](https://a.example.test) ',
        content: [{ type: 'content', content: { type: 'text', text: 'ignored' } }],
      })
    ).toEqual({ status: 'completed', text: 'Answer[1].\n\nSources:\n[1] [a](https://a.example.test)' })
    expect(
      parseAntigravitySearchToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'First.' } },
          { type: 'content', content: { type: 'text', text: 'Second.' } },
        ],
      })
    ).toEqual({ status: 'completed', text: 'First.\n\nSecond.' })
  })

  it('reads the text of a failed call and ignores calls still running', () => {
    expect(
      parseAntigravitySearchToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'RESOURCE_EXHAUSTED' } }],
      })
    ).toEqual({ status: 'failed', error: 'RESOURCE_EXHAUSTED' })
    expect(
      parseAntigravitySearchToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'in_progress',
        rawInput: { query: 'q' },
      })
    ).toBeNull()
    expect(
      parseAntigravitySearchToolUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text' } })
    ).toBeNull()
  })
})
