import { tool, type ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  guardToolSet,
  MAX_INVALID_TOOL_STEPS,
  ToolLoopGuard,
  ToolLoopGuardRefusal,
  trailingInvalidToolSteps,
} from '../../src/main/chat/tool-robustness/loop-guard'
import { createRepetitionWatch, detectRepetition } from '../../src/main/chat/tool-robustness/repetition-watch'
import { adaptToolSetForModel } from '../../src/main/chat/tool-capabilities'

type Execute = (input: unknown, options: unknown) => Promise<unknown>

const inputSchema = z.object({ path: z.string().optional(), id: z.string().optional() })

function makeTools(results: Record<string, () => unknown> = {}) {
  const calls: Array<{ name: string; input: unknown }> = []
  const make = (name: string): ToolSet[string] =>
    tool({
      inputSchema: inputSchema,
      execute: async (input: z.infer<typeof inputSchema>) => {
        calls.push({ name, input })
        const result = results[name]
        return result ? result() : `${name} ok`
      },
    })
  const tools: ToolSet = {
    read: make('read'),
    grep: make('grep'),
    edit: make('edit'),
    wait_conversation: make('wait_conversation'),
    flaky: make('flaky'),
  }
  return { tools, calls }
}

function caller(tools: ToolSet) {
  const signal = new AbortController().signal
  return async (name: string, input: unknown = { path: 'a.ts' }) => {
    try {
      return {
        ok: true as const,
        value: await (tools[name].execute as Execute)(input, { toolCallId: 'x', abortSignal: signal }),
      }
    } catch (error) {
      return { ok: false as const, error: error as Error }
    }
  }
}

describe('ToolLoopGuard', () => {
  it('notes, then refuses, then stops identical calls that return the same result', async () => {
    const { tools, calls } = makeTools()
    const events = vi.fn()
    const guard = new ToolLoopGuard(undefined, events)
    const call = caller(guardToolSet(tools, guard))
    expect(await call('read')).toEqual({ ok: true, value: 'read ok' })
    expect(await call('read')).toEqual({ ok: true, value: 'read ok' })
    const third = await call('read')
    expect(third.ok && String(third.value)).toMatch(/^read ok\n\n\[Maestrly: this is the 3rd call to `read`/)
    expect((await call('read')).ok).toBe(true)
    const fifth = await call('read')
    expect(fifth.ok).toBe(false)
    expect(!fifth.ok && fifth.error).toBeInstanceOf(ToolLoopGuardRefusal)
    expect(!fifth.ok && fifth.error.message).toMatch(/did not run this call: `read` was already called 4 times/)
    expect(calls).toHaveLength(4)
    expect(guard.stopped).toBeNull()
    // Other calls still run after a refusal; repeating the refused one stops the turn.
    expect(await call('read', { path: 'b.ts' })).toEqual({ ok: true, value: 'read ok' })
    const retry = await call('read')
    expect(!retry.ok && retry.error.message).toMatch(/stopped this turn because `read` kept repeating/)
    expect(guard.stopped).toMatchObject({ toolName: 'read', reason: 'blocked-retry' })
    const after = await call('grep', { path: 'x' })
    expect(!after.ok && after.error.message).toMatch(/Do not call more tools/)
    expect(calls).toHaveLength(5)
    expect(events.mock.calls.map(([event]) => event.action)).toEqual(['warn', 'warn', 'block', 'stop'])
  })

  it('refuses a call that keeps failing the same way sooner', async () => {
    const { tools, calls } = makeTools({
      flaky: () => {
        throw new Error('ENOENT: no such file')
      },
    })
    const guard = new ToolLoopGuard()
    const call = caller(guardToolSet(tools, guard))
    expect(await call('flaky')).toMatchObject({ ok: false, error: { message: 'ENOENT: no such file' } })
    const second = await call('flaky')
    expect(!second.ok && second.error.message).toMatch(
      /^ENOENT: no such file\n\n\[Maestrly: `flaky` failed the same way 2 times/
    )
    const third = await call('flaky')
    expect(!third.ok && third.error.message).toMatch(/already failed 2 times with these exact arguments/)
    expect(calls).toHaveLength(2)
    const fourth = await call('flaky')
    expect(!fourth.ok && fourth.error.message).toMatch(/stopped this turn/)
    expect(guard.stopped?.reason).toBe('blocked-retry')
  })

  it('stops after three refusals in a turn', async () => {
    const { tools } = makeTools()
    const guard = new ToolLoopGuard()
    const call = caller(guardToolSet(tools, guard))
    for (const path of ['a', 'b', 'c']) {
      for (let index = 0; index < 4; index++) await call('read', { path })
      await call('read', { path })
    }
    expect(guard.stopped?.reason).toBe('too-many-blocks')
  })

  it('does not count a call whose result changed', async () => {
    let counter = 0
    const { tools } = makeTools({ read: () => `version ${counter++}` })
    const guard = new ToolLoopGuard()
    const call = caller(guardToolSet(tools, guard))
    for (let index = 0; index < 10; index++) {
      expect(await call('read')).toEqual({ ok: true, value: `version ${index}` })
    }
    expect(guard.stopped).toBeNull()
  })

  it('treats the same arguments in another key order as the same call', async () => {
    const { tools, calls } = makeTools()
    const call = caller(guardToolSet(tools, new ToolLoopGuard()))
    for (let index = 0; index < 5; index++)
      await call('read', index % 2 ? { path: 'a', id: '1' } : { id: '1', path: 'a' })
    expect(calls).toHaveLength(4)
  })

  it('forgets earlier repeats after a successful mutation, but keeps counting the mutation itself', async () => {
    const { tools, calls } = makeTools()
    const guard = new ToolLoopGuard()
    const call = caller(guardToolSet(tools, guard))
    for (let index = 0; index < 4; index++) await call('read')
    await call('edit', { path: 'a.ts', id: 'change' })
    expect(await call('read')).toEqual({ ok: true, value: 'read ok' })
    for (let index = 0; index < 3; index++) await call('edit', { path: 'a.ts', id: 'change' })
    const repeatedEdit = await call('edit', { path: 'a.ts', id: 'change' })
    expect(!repeatedEdit.ok && repeatedEdit.error.message).toMatch(/did not run this call: `edit`/)
    expect(calls.filter((entry) => entry.name === 'edit')).toHaveLength(4)
  })

  it('lets pollers repeat and only stops them after thirty identical results', async () => {
    const { tools, calls } = makeTools()
    const guard = new ToolLoopGuard()
    const call = caller(guardToolSet(tools, guard))
    for (let index = 0; index < 30; index++) {
      expect(await call('wait_conversation', { id: 'c' })).toEqual({ ok: true, value: 'wait_conversation ok' })
    }
    expect(guard.stopped).toMatchObject({ toolName: 'wait_conversation', reason: 'polling' })
    expect((await call('wait_conversation', { id: 'c' })).ok).toBe(false)
    expect(calls).toHaveLength(30)
  })

  it('never counts cancellations or permission decisions', async () => {
    const { tools } = makeTools({
      flaky: () => {
        throw Object.assign(new Error('Operation denied by the user.'), { name: 'PermissionRejectedError' })
      },
      grep: () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })
    const guard = new ToolLoopGuard()
    const call = caller(guardToolSet(tools, guard))
    for (let index = 0; index < 6; index++) {
      expect(await call('flaky')).toMatchObject({ ok: false, error: { message: 'Operation denied by the user.' } })
      expect(await call('grep')).toMatchObject({ ok: false, error: { message: 'aborted' } })
    }
    expect(guard.stopped).toBeNull()
  })

  it('keeps the counts of a parent and a subagent apart and wraps a ToolSet once per guard', async () => {
    const { tools, calls } = makeTools()
    const parent = new ToolLoopGuard()
    const parentTools = guardToolSet(tools, parent)
    expect(guardToolSet(parentTools, parent).read).toBe(parentTools.read)
    const child = new ToolLoopGuard()
    const childCall = caller(guardToolSet(parentTools, child))
    for (let index = 0; index < 6; index++) await childCall('read')
    expect(child.stopped?.reason).toBe('blocked-retry')
    expect(parent.stopped).toBeNull()
    expect(await caller(parentTools)('read')).toEqual({ ok: true, value: 'read ok' })
    expect(calls).toHaveLength(5)
  })

  it('guards every runtime through adaptToolSetForModel, one guard per adapted ToolSet', async () => {
    const { tools, calls } = makeTools()
    const first = caller(adaptToolSetForModel({ tools, supportsImages: false }))
    for (let index = 0; index < 5; index++) await first('read')
    expect(calls).toHaveLength(4)
    const guard = new ToolLoopGuard()
    const second = adaptToolSetForModel({ tools, supportsImages: true, loopGuard: guard })
    expect(await caller(second)('read')).toEqual({ ok: true, value: 'read ok' })
    expect(calls).toHaveLength(5)
  })

  it('counts trailing steps with only invalid tool calls', () => {
    const valid = { toolCalls: [{ invalid: false }] }
    const invalid = { toolCalls: [{ invalid: true }, { invalid: true }] }
    const text = { toolCalls: [] }
    expect(trailingInvalidToolSteps([invalid, valid, invalid, invalid])).toBe(2)
    expect(trailingInvalidToolSteps([valid, invalid, invalid, invalid])).toBe(MAX_INVALID_TOOL_STEPS)
    expect(trailingInvalidToolSteps([invalid, { toolCalls: [{ invalid: true }, {}] }])).toBe(0)
    expect(trailingInvalidToolSteps([invalid, text])).toBe(0)
  })
})

/** Deterministic pseudo-random words, for prose that never repeats. */
function prose(length: number, seed = 7): string {
  const words = ['model', 'file', 'change', 'test', 'build', 'review', 'the', 'and', 'with', 'state', 'result', 'path']
  let state = Math.imul(seed + 1, 2654435761) >>> 0 || 1
  let out = ''
  while (out.length < length) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out += words[state % words.length] + (state % 11 === 0 ? '.\n' : ' ')
  }
  return out
}

describe('repetition watch', () => {
  it('flags degenerate output', () => {
    expect(detectRepetition('I will now read the file to check its contents.\n'.repeat(400))).toBe('line')
    expect(detectRepetition('the '.repeat(5000))).toBe('window')
    const sentence = 'Let me reconsider the approach and look at the configuration again before deciding anything. '
    expect(sentence.length % 60).not.toBe(0)
    expect(detectRepetition(prose(2000) + sentence.repeat(200))).toBe('period')
  })

  it('never flags tables, code or varied prose', () => {
    const table = ['| # | File | Status |', '|---|---|---|']
    for (let index = 0; index < 800; index++) table.push(`| ${index} | src/module-${index}.ts | passed |`)
    expect(table.join('\n').length).toBeGreaterThan(16_000)
    expect(detectRepetition(table.join('\n'))).toBeNull()
    const code: string[] = []
    for (let index = 0; index < 600; index++) {
      code.push(`export function handler${index}(input: Input) {`, `  return transform(input, ${index})`, '}')
    }
    expect(detectRepetition(code.join('\n'))).toBeNull()
    expect(detectRepetition(prose(40_000))).toBeNull()
  })

  it('checks a channel only after it holds enough text, and keeps channels apart', () => {
    const watch = createRepetitionWatch()
    const line = 'Thinking about the same thing again and again.\n'
    let verdict = null
    let pushed = 0
    while (!verdict && pushed < 100_000) {
      verdict = watch.push('reasoning', line)
      expect(watch.push('text', prose(line.length, pushed))).toBeNull()
      pushed += line.length
    }
    expect(verdict).toEqual({ channel: 'reasoning', kind: 'line' })
    expect(pushed).toBeGreaterThanOrEqual(16_000)
    expect(pushed).toBeLessThan(16_000 + line.length * 2)
  })
})
