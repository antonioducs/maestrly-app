import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool, jsonSchema, type ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginHook } from '../../src/main/plugins/runtime'

const hooks = vi.hoisted(() => ({ list: [] as ActivePluginHook[] }))
vi.mock('../../src/main/plugins/runtime', async (original) => ({
  ...(await original<typeof import('../../src/main/plugins/runtime')>()),
  listPluginHooks: () => hooks.list,
}))

const {
  hooksActive,
  runPostToolUse,
  runPreToolUse,
  runSessionStart,
  runStop,
  runUserPromptSubmit,
  wrapToolSetWithHooks,
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
const ctx = (mode: 'agent' | 'ask' = 'agent') => ({
  conversationId: 'conv-1',
  cwd: dir,
  mode,
  permMode: 'full' as const,
  reviewer: false,
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
    expect(await runStop(ctx(), false)).toEqual({ continueWith: 'run the tests' })
    expect(await runStop(ctx(), true)).toEqual({})
  })

  it('runs only in Agent conversations', async () => {
    hooks.list = [hook('Stop', `process.exit(0)`)]
    expect(hooksActive(ctx('agent'))).toBe(true)
    expect(hooksActive(ctx('ask'))).toBe(false)
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
  })
})
