import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '../../src/main/chat/agents'
import { approvalConfig } from '../../src/main/chat/codex-subscription/runner'
import { SYSTEM_PROMPT } from '../../src/main/chat/runner'
import { builtinToolNamesForMode, isSubagentReadOnly } from '../../src/main/chat/tools'
import { APP_TOOL_POLICY, appToolAllowed, externalMcpToolAllowed } from '../../src/main/chat/tool-policy'
import { MAESTRO_DELEGATE_TOOL_SCHEMA, maestroAgentsFromTurn } from '../../src/main/chat/maestro-delegation'
import { resolveChatBehavior } from '../../src/shared/conversation-experience'
import { createDefaultMaestroConfig } from '../../src/shared/maestro'

describe('Maestro parent/worker capability boundary', () => {
  it('gives the parent only read-only built-ins and no shell/write/edit/artifact tools', () => {
    expect(resolveChatBehavior('standard', 'plan')).toBe('plan')
    expect(resolveChatBehavior('standard', 'design')).toBe('design')
    expect(resolveChatBehavior('maestro', 'agent')).toBe('maestro')
    expect(resolveChatBehavior('maestro', 'ask')).toBe('maestro')
    const names = builtinToolNamesForMode('maestro')
    expect([...names]).toEqual(expect.arrayContaining(['read', 'grep', 'glob']))
    for (const forbidden of ['bash', 'write', 'edit', 'generate_image', 'review_plan', 'todo_write']) {
      expect(names.has(forbidden)).toBe(false)
    }
    expect(approvalConfig('maestro', 'full')).toMatchObject({ sandbox: 'read-only' })
    expect(SYSTEM_PROMPT('/repo', true, 'maestro', true)).toContain('parent is structurally read-only')
  })

  it('requires the parent to choose an agent while keeping execution details out of delegate input', () => {
    const properties = Object.keys(MAESTRO_DELEGATE_TOOL_SCHEMA.properties)
    expect(properties).toEqual(expect.arrayContaining(['agent', 'task', 'kind', 'domain', 'reviewOf', 'independent']))
    expect(MAESTRO_DELEGATE_TOOL_SCHEMA.required).toContain('agent')
    expect(properties).not.toEqual(
      expect.arrayContaining(['provider', 'providerId', 'model', 'modelId', 'effort', 'fastMode'])
    )
  })

  it('tells review resources that scoped browser and terminal validation are operationally available', () => {
    const config = createDefaultMaestroConfig()
    const agents = maestroAgentsFromTurn({
      version: 1,
      strategy: config.strategy,
      pool: config.pool,
      source: 'safe-default',
      diagnostics: [],
      frozenAt: 1,
    })
    const reviewer = agents.find((agent) => agent.name === 'reviewer')!
    expect(reviewer.prompt).toContain('full operational tool catalog')
    expect(reviewer.prompt).toContain('isolated browser tabs and terminals')
  })

  it('allows only proven read-only MCP/app tools while Pool workers remain mutable', () => {
    expect(externalMcpToolAllowed('maestro', { readOnlyHint: true })).toBe(true)
    expect(externalMcpToolAllowed('maestro', { readOnlyHint: false })).toBe(false)
    expect(appToolAllowed('maestro', 'memory_search')).toBe(true)
    expect(appToolAllowed('maestro', 'notes_read_page')).toBe(true)
    for (const mutating of ['browser_navigate', 'notes_write_page', 'project_notes_append_page']) {
      expect(appToolAllowed('maestro', mutating), mutating).toBe(false)
    }
    for (const [name, policy] of Object.entries(APP_TOOL_POLICY)) {
      if (appToolAllowed('maestro', name)) expect(policy.readOnly, name).toBe(true)
    }
    const worker = BUILTIN_AGENTS.find((agent) => agent.name === 'general-purpose')!
    expect(isSubagentReadOnly('maestro', worker.tools, new Set(worker.tools))).toBe(false)
    expect(isSubagentReadOnly('maestro', undefined, new Set(['read', 'grep']))).toBe(true)
  })

  it('wires delegate and the frozen Maestro snapshot through every parent runtime', () => {
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/runner.ts',
      'src/main/chat/codex-subscription/runner.ts',
      'src/main/chat/github-copilot/runner.ts',
    ]) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toContain("'delegate'")
      expect(source, file).toContain('maestro')
      expect(source, file).toContain('maestroLive')
    }
    const codex = readFileSync('src/main/chat/codex-subscription/runner.ts', 'utf8')
    expect(codex).toContain("toolName === 'task' || toolName === 'delegate'")
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/runner.ts',
      'src/main/chat/codex-subscription/runner.ts',
      'src/main/chat/github-copilot/runner.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('renderMaestroAgentCatalog')
    }
  })

  it('keeps the full worker catalog behind child execution in every runtime', () => {
    const executor = readFileSync('src/main/chat/subagent-executor.ts', 'utf8')
    const codex = readFileSync('src/main/chat/codex-subscription/runner.ts', 'utf8')
    expect(executor).toContain('buildMaestroWorkerTools({')
    expect(codex).toContain('buildMaestroWorkerTools({')
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/task-runtime.ts',
      'src/main/chat/github-copilot/runner.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('executeSubagent({')
    }
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/task-runtime.ts',
      'src/main/chat/github-copilot/runner.ts',
      'src/main/chat/codex-subscription/runner.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('maestroLive: args.maestroLive')
    }
    expect(readFileSync('src/main/chat/maestro-delegation-registry.ts', 'utf8')).toContain(
      'embedPending(input.toolCallId'
    )
    expect(readFileSync('src/main/chat/maestro-worker-tools.ts', 'utf8')).toContain("mode: 'agent'")
    expect(readFileSync('src/main/chat/tool-policy.ts', 'utf8')).toContain("mode !== 'maestro' || entry.readOnly")
  })

  it('keeps the worker skill catalog and loader under the same Maestro-owned boundary', () => {
    const executor = readFileSync('src/main/chat/subagent-executor.ts', 'utf8')
    const codex = readFileSync('src/main/chat/codex-subscription/runner.ts', 'utf8')
    const workerTools = readFileSync('src/main/chat/maestro-worker-tools.ts', 'utf8')

    expect(workerTools).toContain('buildModelSkillRuntime({')
    expect(workerTools).toContain('skillCatalog: skillRuntime.catalog')
    expect(executor).toContain("args.mode !== 'maestro' || name !== 'use_skill'")
    expect(executor).toContain('maestroRuntime.skillCatalog')
    expect(codex).toContain("args.mode !== 'maestro' || name !== 'use_skill'")
    expect(codex).toContain('maestroWorkerRuntime?.skillCatalog')
    expect(codex).toContain('isGitHubCopilotSubscriptionProvider(profile.effective.providerId)')
    expect(codex).toContain('runGitHubCopilotSubagent({')
  })
  it('owns the live inbox in the admitted ActiveRun and settles it before renderer done', () => {
    const service = readFileSync('src/main/chat/service.ts', 'utf8')
    expect(service).toContain('createMaestroLiveRunPort({')
    expect(service).toContain("'chat:maestro-live:post'")
    expect(service).toContain("'chat:maestro-live:snapshot'")
    expect(service).toContain("'chat:maestro-live:cancel'")
    const finish = service.indexOf('run.maestroLive?.finish(maestroTerminalStatus)')
    const doneMarker = 'send(`chat:delta:' + '${' + "conversationId}`, { kind: 'done' })"
    const done = service.indexOf(doneMarker, finish)
    expect(finish).toBeGreaterThan(-1)
    expect(done).toBeGreaterThan(finish)
  })

  it('starts Maestro delegates asynchronously and exposes wait/list/inspect/cancel to every parent runtime', () => {
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/task-runtime.ts',
      'src/main/chat/codex-subscription/runner.ts',
      'src/main/chat/github-copilot/runner.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('startMaestroDelegation({')
    }
    for (const file of [
      'src/main/chat/runner.ts',
      'src/main/chat/claude-agent-sdk/runner.ts',
      'src/main/chat/codex-subscription/runner.ts',
      'src/main/chat/github-copilot/runner.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), file).toContain('buildSubagentSupervisionTools({')
    }
    const supervision = readFileSync('src/main/chat/maestro-supervision-tools.ts', 'utf8')
    for (const tool of ['wait_delegation', 'list_delegations', 'inspect_subagent', 'cancel_delegation']) {
      expect(supervision).toContain(tool)
    }
    const prompt = readFileSync('src/main/chat/maestro-prompt.ts', 'utf8')
    expect(prompt).toContain('Never finish while a delegation is preparing or running')
    expect(readFileSync('src/main/chat/codex-subscription/runner.ts', 'utf8')).toContain('maestroGuardRequired')
    expect(readFileSync('src/main/chat/claude-agent-sdk/runner.ts', 'utf8')).toContain('maestroGuarded')
    expect(readFileSync('src/main/chat/service.ts', 'utf8')).toContain('maestroGuardContinuation')
  })
})
