import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: h.spawn }))
vi.mock('../../src/main/platform', () => ({ freeTerminalShell: () => ({ file: '/bin/sh', args: [] }) }))
vi.mock('../../src/main/store', () => ({ getFreeTerminalShell: () => null }))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: vi.fn(),
  sendToPanel: vi.fn(),
  sendToConversation: vi.fn(),
}))
vi.mock('../../src/main/performance/metrics', () => ({
  incrementPerformanceCounter: vi.fn(),
  recordIpcSend: vi.fn(),
}))
vi.mock('../../src/main/performance/owned-processes', () => ({
  registerOwnedProcess: vi.fn(),
  unregisterOwnedProcess: vi.fn(),
}))

import {
  CONVERSATION_SHELL_ENV_KEYS,
  conversationShellEnv,
  setConversationShellEnv,
  type ConversationShellEnv,
} from '../../src/main/chat/conversation-env'
import { bashTool } from '../../src/main/chat/tools/bash'
import type { ToolContext } from '../../src/main/chat/tools/util'
import { codexShellEnvironmentConfig } from '../../src/main/chat/codex-subscription/host-mcp'
import { __resetCwdActivityForTests } from '../../src/main/cwd-activity-coordinator'
import { createShellTerminal, disposeShellTerminals } from '../../src/main/terminal-manager'

const botA: ConversationShellEnv = {
  DISPLAY: ':3',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/synthetic-bot-a/bus',
  BROWSER: '/tmp/synthetic-bot-a/browser',
  MAESTRLY_BOT_BROWSER_PROFILE: '/tmp/synthetic-bot-a/chromium',
}

function context(conversationId: string, cwd: string): ToolContext {
  return {
    conversationId,
    projectId: null,
    messageId: 'message',
    toolCallId: 'call',
    cwd,
    signal: new AbortController().signal,
    ask: async () => {},
    askQuestion: async () => [],
  }
}

function fakePty() {
  return {
    pid: 4242,
    process: 'sh',
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  }
}

describe('conversation shell environment', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'conversation-env-'))
    // The environment display of the process; conversations without their own environment keep it.
    vi.stubEnv('DISPLAY', ':0')
    vi.stubEnv('MAESTRLY_BOT_BROWSER_PROFILE', '')
    h.spawn.mockReset().mockImplementation(() => fakePty())
    __resetCwdActivityForTests()
    setConversationShellEnv('conv-a', botA)
  })

  afterEach(() => {
    setConversationShellEnv('conv-a', null)
    setConversationShellEnv('conv-b', null)
    disposeShellTerminals('conv-a')
    disposeShellTerminals('conv-b')
    __resetCwdActivityForTests()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps one environment per conversation and drops unknown keys', () => {
    expect(CONVERSATION_SHELL_ENV_KEYS).toEqual([
      'DISPLAY',
      'DBUS_SESSION_BUS_ADDRESS',
      'BROWSER',
      'MAESTRLY_BOT_BROWSER_PROFILE',
      'GTK_THEME',
      'MAESTRLY_DESKTOP_SOCKET',
    ])
    expect(conversationShellEnv('conv-a')).toEqual(botA)
    expect(conversationShellEnv('conv-b')).toEqual({})
    expect(conversationShellEnv(undefined)).toEqual({})

    setConversationShellEnv('conv-b', {
      DISPLAY: ':4',
      PATH: '/tmp/synthetic-evil/bin',
      LD_PRELOAD: '/tmp/synthetic-evil/lib.so',
      BROWSER: 42,
    } as unknown as ConversationShellEnv)
    expect(conversationShellEnv('conv-b')).toEqual({ DISPLAY: ':4' })

    // Callers get a copy; changing it never changes the registry.
    const copy = conversationShellEnv('conv-a')
    copy.DISPLAY = ':9'
    expect(conversationShellEnv('conv-a').DISPLAY).toBe(':3')

    setConversationShellEnv('conv-b', null)
    expect(conversationShellEnv('conv-b')).toEqual({})
    setConversationShellEnv('conv-b', {})
    expect(conversationShellEnv('conv-b')).toEqual({})
  })

  it.skipIf(process.platform === 'win32')('runs bash with the display of its own conversation', async () => {
    const command = 'printf "%s|%s|%s" "$DISPLAY" "$MAESTRLY_BOT_BROWSER_PROFILE" "$PATH"'
    const a = await bashTool.execute({ command }, context('conv-a', dir))
    const b = await bashTool.execute({ command }, context('conv-b', dir))

    expect(a.output).toBe(`:3|/tmp/synthetic-bot-a/chromium|${process.env.PATH}`)
    expect(b.output).toBe(`:0||${process.env.PATH}`)
  })

  it.skipIf(process.platform === 'win32')('never lets an unknown key reach bash', async () => {
    setConversationShellEnv('conv-b', {
      DISPLAY: ':4',
      PATH: '/tmp/synthetic-evil/bin',
    } as unknown as ConversationShellEnv)
    const result = await bashTool.execute({ command: 'printf "%s|%s" "$DISPLAY" "$PATH"' }, context('conv-b', dir))
    expect(result.output).toBe(`:4|${process.env.PATH}`)
  })

  it('starts conversation terminals with the registered environment and keeps other terminals unchanged', () => {
    const a = createShellTerminal('conv-a', dir)
    const b = createShellTerminal('conv-b', dir)
    expect(a.ok && b.ok).toBe(true)

    const envOf = (index: number) => (h.spawn.mock.calls[index][2] as { env: Record<string, string | undefined> }).env
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(envOf(0)).toMatchObject({ ...botA, TERM: 'xterm-256color', PATH: process.env.PATH })
    expect(envOf(1)).toMatchObject({
      DISPLAY: ':0',
      MAESTRLY_BOT_BROWSER_PROFILE: '',
      TERM: 'xterm-256color',
      PATH: process.env.PATH,
    })
  })

  it('maps the environment to Codex per-thread shell policy entries', () => {
    expect(codexShellEnvironmentConfig({ DISPLAY: ':3', BROWSER: '/tmp/synthetic-bot-a/browser' })).toEqual({
      'shell_environment_policy.set.DISPLAY': ':3',
      'shell_environment_policy.set.BROWSER': '/tmp/synthetic-bot-a/browser',
    })
    expect(codexShellEnvironmentConfig({})).toEqual({})
  })
})
