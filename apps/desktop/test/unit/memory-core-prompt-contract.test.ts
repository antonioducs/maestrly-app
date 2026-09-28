import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '../../src/main/chat')
const calls: Array<[string, RegExp]> = [
  ['runner.ts', /build(?:OpenAI)?ProjectContext\(projectId, cwd, conversationId\)/g],
  ['claude-agent-sdk/runner.ts', /buildProjectContext\(args\.projectId, args\.cwd, args\.conversationId\)/],
  ['github-copilot/runner.ts', /buildProjectContext\(args\.projectId, args\.cwd, args\.conversationId\)/],
  ['codex-subscription/runner.ts', /buildProjectContext\(args\.projectId, args\.cwd, args\.conversationId\)/],
  ['cursor-subscription/session.ts', /buildProjectContext\(args\.projectId, args\.cwd, args\.conversationId\)/],
]

describe('memory core reaches every runtime prompt', () => {
  it.each(calls)('%s passes the conversation id to the project context', (file, pattern) => {
    expect(readFileSync(path.join(root, file), 'utf8')).toMatch(pattern)
  })
})
