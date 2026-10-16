import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool, jsonSchema, type ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginHook } from '../../src/main/plugins/runtime'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

const hooks = vi.hoisted(() => ({ list: [] as ActivePluginHook[] }))
vi.mock('../../src/main/plugins/runtime', async (original) => ({
  ...(await original<typeof import('../../src/main/plugins/runtime')>()),
  listPluginHooks: () => hooks.list,
}))
vi.mock('../../src/main/chat/chat-store', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/chat-store')>()),
  listConversationContextMessages: () => [
    { role: 'user', parts: [{ type: 'text', text: 'synthetic question' }] },
    {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'hidden' },
        { type: 'text', text: 'synthetic answer' },
      ],
    },
    { role: 'assistant', parts: [{ type: 'tool', toolName: 'bash' }] },
  ],
}))

const {
  companionHooksRefusal,
  hasToolHooks,
  hookSessionBoundary,
  hooksActive,
  pluginsWithTurnHooks,
  removeHookTranscript,
  runPostToolUse,
  runPreToolUse,
  runSessionStart,
  runStop,
  runUserPromptSubmit,
  sessionStartSource,
  stopHookPrompt,
  wrapToolSetWithHooks,
  writeHookTranscript,
} = await import('../../src/main/chat/plugin-hooks')
const { claudeToolName, fromClaudeInput, toClaudeInput } = await import('../../src/main/chat/plugin-hook-tools')

const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-hooks-'))
let n = 0
/** A synthetic hook script: reads its JSON input from stdin and runs `body` with it as `input`. */
function hook(event: ActivePluginHook['spec']['event'], body: string, matcher: string | null = null): ActivePluginHook {
  const file = path.join(dir, `hook-${++n}.mjs`)
  writeFileSync(
    file,
    `let raw = ''\nprocess.stdin.on('data', (c) => (raw += c))\nprocess.stdin.on('end', () => { const input = JSON.parse(raw); ${body} })\n`
  )
  return {
    pluginKey: 'guard@market',
    pluginName: 'Guard',
    spec: { event, matcher, command: `node ${JSON.stringify(file)}`, timeoutSec: 10, source: 'hooks/hooks.json' },
    command: `node ${JSON.stringify(file)}`,
    env: { PLUGIN_ROOT: dir },
  }
}

const notices: unknown[] = []
const ctx = (mode: ChatBehavior = 'agent') => ({
  conversationId: 'conv-1',
  cwd: dir,
  mode,
  permMode: 'full' as const,
  signal: new AbortController().signal,
  transcriptPath: async () => path.join(dir, 'transcript.jsonl'),
  notify: (notice: unknown) => notices.push(notice),
})

beforeEach(() => {
  hooks.list = []
  notices.length = 0
})

describe('plugin hook tool names', () => {
  it('maps Maestrly tools and inputs to Claude Code names and back', () => {
    expect(claudeToolName('bash')).toBe('Bash')
    expect(claudeToolName('web_search')).toBe('WebSearch')
    expect(claudeToolName('edit')).toBe('Edit')
    expect(claudeToolName('protected__whoami')).toBe('mcp__protected__whoami')
    expect(toClaudeInput('edit', { path: 'a.ts', oldString: 'x', newString: 'y' })).toEqual({
      file_path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
    })
    expect(fromClaudeInput('edit', { file_path: 'b.ts', old_string: 'x', new_string: 'z' })).toEqual({
      path: 'b.ts',
      oldString: 'x',
      newString: 'z',
    })
    expect(toClaudeInput('local_shell', { action: { type: 'exec', command: ['ls', '-la'] } })).toEqual({
      command: 'ls -la',
    })
  })
})

describe('plugin hooks', () => {
  it('lets a PreToolUse hook deny a call, see Claude Code inputs, and change the command', async () => {
    hooks.list = [
      hook(
        'PreToolUse',
        `if (input.tool_input.command.includes('forbidden')) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no forbidden commands' } }))
         else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: input.tool_input.command + ' --safe' } } }))`,
        'Bash'
      ),
      hook('PreToolUse', `process.stdout.write(JSON.stringify({ seen: input.tool_input }))`, 'Edit|Write'),
    ]
    expect(await runPreToolUse(ctx(), 'bash', { command: 'rm forbidden' })).toMatchObject({
      block: 'no forbidden commands',
    })
    // `allow` changes nothing about Maestrly's own permission: only the input is updated.
    expect(await runPreToolUse(ctx(), 'bash', { command: 'ls' })).toMatchObject({ input: { command: 'ls --safe' } })
    expect((await runPreToolUse(ctx(), 'read', { path: 'a' })).block).toBeUndefined()
  })

  it('appends what a PostToolUse hook reports with exit 2, and turns failures into notices', async () => {
    hooks.list = [
      hook('PostToolUse', `process.stderr.write('lint: 2 problems'); process.exit(2)`),
      hook('PostToolUse', `process.stderr.write('crashed'); process.exit(1)`),
    ]
    expect(await runPostToolUse(ctx(), 'edit', { path: 'a' }, 'ok', false)).toEqual({ append: ['lint: 2 problems'] })
    expect(notices).toEqual([expect.objectContaining({ plugin: 'Guard', event: 'PostToolUse', level: 'error' })])
  })

  it('adds prompt context, blocks a prompt, starts a session, and keeps the agent going from a Stop hook', async () => {
    hooks.list = [hook('UserPromptSubmit', `process.stdout.write('PROMPT-CONTEXT for ' + input.prompt)`)]
    expect(await runUserPromptSubmit(ctx(), 'hello')).toEqual({ context: ['PROMPT-CONTEXT for hello'] })
    hooks.list = [
      hook('UserPromptSubmit', `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'no secrets' }))`),
    ]
    expect(await runUserPromptSubmit(ctx(), 'secret')).toMatchObject({ block: 'no secrets' })
    hooks.list = [hook('SessionStart', `process.stdout.write('SESSION ' + input.source)`, 'startup')]
    expect(await runSessionStart(ctx(), 'startup')).toEqual({ context: ['SESSION startup'] })
    expect(await runSessionStart(ctx(), 'compact')).toEqual({ context: [] })
    hooks.list = [
      hook(
        'Stop',
        `process.stdout.write(input.stop_hook_active ? '' : JSON.stringify({ decision: 'block', reason: 'run the tests' }))`
      ),
    ]
    expect(await runStop(ctx(), false)).toEqual({ continueWith: 'run the tests', plugin: 'Guard' })
    expect(await runStop(ctx(), true)).toEqual({})
  })

  it('runs only in Agent and Design conversations', async () => {
    hooks.list = [hook('Stop', `process.exit(0)`)]
    expect(hooksActive(ctx('agent'))).toBe(true)
    expect(hooksActive(ctx('design'))).toBe(true)
    for (const mode of ['ask', 'plan', 'maestro'] as const) expect(hooksActive(ctx(mode))).toBe(false)
    expect(await runStop(ctx('maestro'), false)).toEqual({})
  })

  it('tells tool hooks from the hooks only a Maestrly-run turn has', () => {
    hooks.list = [hook('PostToolUse', `process.exit(0)`)]
    expect(hasToolHooks('conv-1', 'agent')).toBe(true)
    expect(hasToolHooks('conv-1', 'plan')).toBe(false)
    expect(pluginsWithTurnHooks('conv-1')).toEqual([])
    hooks.list = [hook('SessionStart', `process.exit(0)`), hook('Stop', `process.exit(0)`)]
    expect(hasToolHooks('conv-1', 'agent')).toBe(false)
    expect(pluginsWithTurnHooks('conv-1')).toEqual(['Guard'])
    // A ChatGPT web companion cannot run them, so it does not start in Agent; Ask runs no hooks at all.
    expect(companionHooksRefusal('conv-1', 'agent')).toBe('companion-hooks-unsupported: Guard')
    expect(companionHooksRefusal('conv-1', 'ask')).toBeNull()
    hooks.list = [hook('PreToolUse', `process.exit(0)`)]
    expect(companionHooksRefusal('conv-1', 'agent')).toBeNull()
  })

  it('writes an owner-only transcript of the conversation text and removes it', () => {
    const file = writeHookTranscript('conv/../1')
    expect(path.basename(file)).toBe('conv____1.jsonl')
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'synthetic question' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic answer' }] } },
    ])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    removeHookTranscript('conv/../1')
    expect(existsSync(file)).toBe(false)
  })

  it('wraps every tool of a ToolSet: a denied call never runs, and PostToolUse text reaches the model', async () => {
    const ran: unknown[] = []
    const tools: ToolSet = {
      bash: tool({
        description: 'shell',
        inputSchema: jsonSchema({ type: 'object', properties: { command: { type: 'string' } } }),
        execute: async (input: unknown) => {
          ran.push(input)
          return 'output'
        },
      }),
    }
    hooks.list = [
      hook(
        'PreToolUse',
        `if (input.tool_input.command === 'bad') { process.stderr.write('blocked'); process.exit(2) }`,
        'Bash'
      ),
      hook(
        'PostToolUse',
        `process.stdout.write(JSON.stringify({ decision: 'block', reason: 'check the output' }))`,
        'Bash'
      ),
    ]
    const wrapped = wrapToolSetWithHooks(tools, ctx())
    const execute = wrapped.bash.execute as (input: unknown, options: unknown) => Promise<unknown>
    await expect(execute({ command: 'bad' }, { toolCallId: 't1', messages: [] })).rejects.toThrow(
      'Blocked by plugin hook: blocked'
    )
    expect(ran).toEqual([])
    expect(await execute({ command: 'ls' }, { toolCallId: 't2', messages: [] })).toBe('output\n\ncheck the output')
    expect(wrapToolSetWithHooks(tools, ctx('ask'))).toBe(tools)
    // A ToolSet handed on to a subagent keeps one layer of hooks.
    expect(wrapToolSetWithHooks(wrapped, ctx()).bash).toBe(wrapped.bash)
  })
})

describe('plugin hook sessions', () => {
  it('starts a session when none ran, after a clear, or past a newer compaction', () => {
    const marker = (id: string) => ({
      id: `m-${id}`,
      conversationId: 'conv-1',
      role: 'assistant' as const,
      createdAt: 1,
      parts: [{ type: 'compaction' as const, id, text: 'summary', strategy: 'summary' as const }],
    })
    expect(hookSessionBoundary([])).toBe('')
    expect(hookSessionBoundary([marker('a'), marker('b')])).toBe('b')
    expect(sessionStartSource(undefined, '', false)).toBe('startup')
    // Hooks that never ran for a conversation with history, here or on the host it moved from, resume it.
    expect(sessionStartSource(undefined, '', true)).toBe('resume')
    expect(sessionStartSource({ cleared: true }, '', false)).toBe('clear')
    expect(sessionStartSource({ boundary: '' }, '', true)).toBeNull()
    expect(sessionStartSource({ boundary: 'a' }, 'b', true)).toBe('compact')
  })

  it('words the prompt that keeps the agent going', () => {
    expect(stopHookPrompt('Guard', 'run the tests')).toBe('Stop hook feedback from the Guard plugin:\nrun the tests')
  })
})
