import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const main = path.resolve(__dirname, '../../src/main/chat')

// Hooks behave the same with every model only if every runtime's tools go through them. Reading the sources keeps
// this check free of each runtime's startup.
describe('plugin hooks reach every runtime', () => {
  it.each([
    'runner.ts',
    'claude-agent-sdk/runner.ts',
    'codex-subscription/runner.ts',
    'cursor-subscription/runner.ts',
    'github-copilot/runner.ts',
    'antigravity-subscription/runner.ts',
    'subagent-executor.ts',
  ])('%s wraps its tools', (file) => {
    expect(readFileSync(path.join(main, file), 'utf8')).toContain('wrapToolSetWithHooks(')
  })

  it('runs tool hooks around the ChatGPT web companion tools', () => {
    expect(readFileSync(path.join(main, 'chatgpt-web/bridge-server.ts'), 'utf8')).toContain('toolHooks')
    expect(readFileSync(path.join(main, 'chatgpt-web/manager.ts'), 'utf8')).toContain('runPreToolUse(')
  })
})
