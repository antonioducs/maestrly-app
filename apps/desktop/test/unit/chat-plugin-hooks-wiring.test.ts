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

  it('sends a steered message to a turn of its own when prompt hooks exist, so they see it', () => {
    const service = readFileSync(path.join(main, 'service.ts'), 'utf8')
    const steer = service.slice(service.indexOf("'chat:steer',"), service.indexOf('control.steer('))
    expect(steer).toContain("hasHookEvent(conversationId, behaviorFor(conversationId), 'UserPromptSubmit')")
  })

  it('runs tool hooks around the ChatGPT web companion tools', () => {
    expect(readFileSync(path.join(main, 'chatgpt-web/bridge-server.ts'), 'utf8')).toContain('toolHooks')
    const manager = readFileSync(path.join(main, 'chatgpt-web/manager.ts'), 'utf8')
    expect(manager).toContain('runPreToolUse(')
    // A new session is refused before its transport starts.
    const start = manager.slice(manager.indexOf('export async function startSession('))
    const transport = start.indexOf(
      'await ensureTransport()\n    // Clear/end/disable may occur while the daemon starts.'
    )
    expect(transport).toBeGreaterThan(-1)
    expect(start.indexOf('companionHooksRefusal(')).toBeGreaterThan(-1)
    expect(start.indexOf('companionHooksRefusal(')).toBeLessThan(transport)
  })
})
