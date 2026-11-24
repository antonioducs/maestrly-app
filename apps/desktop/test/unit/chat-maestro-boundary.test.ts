import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../../src/main/chat/agents'
import { approvalConfig } from '../../src/main/chat/codex-subscription/runner'
import { builtinToolNamesForMode, isSubagentReadOnly } from '../../src/main/chat/tools'
import {
  APP_TOOL_POLICY,
  CONVERSATION_DISPATCH_TOOL_NAMES,
  CONVERSATION_LINK_TOOL_NAMES,
  PARENT_ONLY_CONVERSATION_TOOL_NAMES,
  appToolAllowed,
  conversationDispatchToolsAllowed,
  conversationLinkToolsAllowed,
  externalMcpToolAllowed,
} from '../../src/main/chat/tool-policy'
import { resolveChatBehavior } from '../../src/shared/conversation-experience'
import { capabilityBehaviorFor } from '../../src/shared/chat-mode'
import { buildMaestrlyBasePrompt, hostCapabilitySection } from '../../src/main/chat/harness/host-contracts'
import { harnessFor } from '../../src/main/chat/harness/execution'
import type { ChatBehavior } from '../../src/shared/conversation-experience'

/** Host base prompt for an unspecialized model: the declarative equivalent of the legacy SYSTEM_PROMPT. */
const SYSTEM_PROMPT = (
  cwd: string,
  appToolsEnabled: boolean,
  mode: ChatBehavior,
  hasNotesTab: boolean,
  modelId = 'generic-model'
): string =>
  buildMaestrlyBasePrompt({
    harness: harnessFor('openai', modelId),
    cwd,
    appToolsEnabled,
    mode,
    hasNotesTab,
  })

describe('Maestro orchestrator capability boundary', () => {
  it('gives the Maestro parent full Agent built-in capabilities while keeping behavior as maestro', () => {
    expect(resolveChatBehavior('standard', 'plan')).toBe('plan')
    expect(resolveChatBehavior('standard', 'design')).toBe('design')
    expect(resolveChatBehavior('maestro', 'agent')).toBe('maestro')
    expect(resolveChatBehavior('maestro', 'ask')).toBe('maestro')
    expect(capabilityBehaviorFor('maestro')).toBe('agent')

    const maestroNames = builtinToolNamesForMode('maestro')
    const agentNames = builtinToolNamesForMode('agent')
    expect([...maestroNames].sort()).toEqual([...agentNames].sort())
    for (const expected of ['read', 'grep', 'glob', 'edit', 'write', 'bash', 'todo_write']) {
      expect(maestroNames.has(expected), expected).toBe(true)
    }
    expect(approvalConfig('maestro', 'full')).toEqual(approvalConfig('agent', 'full'))
    expect(approvalConfig('maestro', 'auto')).toEqual(approvalConfig('agent', 'auto'))
    expect(hostCapabilitySection('maestro')).toBe(hostCapabilitySection('agent'))
  })

  it('gives the Maestro parent the same base prompt as Agent across profiles', () => {
    for (const modelId of ['generic-model', 'claude-opus-5', 'gemini-4-argon']) {
      const maestro = SYSTEM_PROMPT('/repo', true, 'maestro', true, modelId)
      const agent = SYSTEM_PROMPT('/repo', true, 'agent', true, modelId)
      expect(maestro, modelId).toBe(agent)
      expect(maestro, modelId).toContain('`edit`/`write` to change them')
      expect(maestro, modelId).not.toContain('parent is structurally read-only')
      expect(maestro, modelId).not.toContain('Workers change code and run checks')
    }
  })

  it('allows full MCP and app tools for Maestro like Agent', () => {
    expect(externalMcpToolAllowed('maestro', { readOnlyHint: true })).toBe(true)
    expect(externalMcpToolAllowed('maestro', { readOnlyHint: false })).toBe(true)
    for (const name of Object.keys(APP_TOOL_POLICY)) {
      expect(appToolAllowed('maestro', name), name).toBe(appToolAllowed('agent', name))
    }
    expect(appToolAllowed('maestro', 'browser_navigate')).toBe(true)
    expect(appToolAllowed('maestro', 'browser_snapshot')).toBe(true)
    expect(appToolAllowed('maestro', 'computer_screenshot')).toBe(true)
    expect(appToolAllowed('maestro', 'notes_write_page')).toBe(true)
    expect(appToolAllowed('maestro', 'review_plan')).toBe(false)

    const generalPurpose = BUILTIN_AGENTS.find((agent) => agent.name === 'general-purpose')!
    expect(isSubagentReadOnly('maestro', generalPurpose.tools, new Set(generalPurpose.tools))).toBe(false)
    expect(isSubagentReadOnly('maestro', undefined, new Set(['read', 'grep']))).toBe(true)
  })

  it('allows conversation dispatch and link tools for Maestro while keeping them out of workers and subagents', () => {
    expect(conversationDispatchToolsAllowed('maestro')).toBe(true)
    expect(conversationLinkToolsAllowed('maestro')).toBe(true)
    for (const name of [...CONVERSATION_DISPATCH_TOOL_NAMES, ...CONVERSATION_LINK_TOOL_NAMES]) {
      expect(PARENT_ONLY_CONVERSATION_TOOL_NAMES).toContain(name)
    }
    for (const file of [
      'src/main/chat/tools/index.ts',
      'src/main/chat/claude-agent-sdk/subagent-runner.ts',
      'src/main/chat/claude-agent-sdk/task-runtime.ts',
      'src/main/chat/github-copilot/subagent-runner.ts',
      'src/main/chat/cursor-subscription/subagent-runner.ts',
      'src/main/chat/antigravity-subscription/subagent-runner.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('...PARENT_ONLY_CONVERSATION_TOOL_NAMES')
    }
  })

  it('wires the swarm prompt through every runner and removes legacy delegate tool and live port usage', () => {
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/runner.ts',
      'src/main/chat/codex-subscription/runner.ts',
      'src/main/chat/github-copilot/runner.ts',
      'src/main/chat/cursor-subscription/session.ts',
      'src/main/chat/antigravity-subscription/session.ts',
    ]) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toContain('renderMaestroSwarmSection')
      expect(source, file).not.toContain('renderMaestroAgentCatalog')
      expect(source, file).not.toContain('renderMaestroTurnPolicy')
      expect(source, file).not.toContain('MAESTRO_SYSTEM_SPEC')
      expect(source, file).not.toContain('MAESTRO_DELEGATE_TOOL')
    }

    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/runner.ts',
      'src/main/chat/claude-agent-sdk/task-runtime.ts',
      'src/main/chat/codex-subscription/runner.ts',
      'src/main/chat/github-copilot/runner.ts',
      'src/main/chat/cursor-subscription/runner.ts',
      'src/main/chat/cursor-subscription/task-runtime.ts',
      'src/main/chat/antigravity-subscription/runner.ts',
      'src/main/chat/antigravity-subscription/task-runtime.ts',
    ]) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toContain('startMaestroDelegation')
      expect(source, file).not.toContain('prepareMaestroDelegation')
      expect(source, file).not.toContain('maestroLive')
    }

    const service = readFileSync('src/main/chat/service.ts', 'utf8')
    expect(service).toContain('reconcileSwarmMerges')
    expect(service).toContain('maestroSwarmStatePart')
    expect(service).not.toContain('createMaestroLiveRunPort(')
    expect(service).not.toContain('maestroGuardContinuation')
  })
})
