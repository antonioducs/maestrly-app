import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_AGENT_SDK_VERSION, ClaudeSubscriptionManager } from '../../src/main/chat/claude-agent-sdk/manager'
import { gatedClaudeHumanText } from '../../src/main/chat/claude-agent-sdk/user-prompt'

const temporaryDirectories: string[] = []
const managers: ClaudeSubscriptionManager[] = []

async function realManager(): Promise<ClaudeSubscriptionManager> {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'maestrly-claude-smoke-'))
  temporaryDirectories.push(userData)
  const manager = new ClaudeSubscriptionManager({ getUserDataPath: () => userData })
  managers.push(manager)
  return manager
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Claude subscription runtime smoke', () => {
  it('probes the real CLI version and isolated auth status without starting a model turn', async () => {
    const manager = await realManager()
    const status = await manager.status({ refresh: true })

    expect(status.sdkVersion).toBe(CLAUDE_AGENT_SDK_VERSION)
    if (!status.available) {
      expect(status.state).toBe('unavailable')
      expect(status.error).toBeTruthy()
      return
    }
    expect(status.cliVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(['ready', 'signed-out', 'error']).toContain(status.state)
    if (status.authenticated) {
      expect(status.accountFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
      const models = await manager.listModels()
      expect(models.length).toBeGreaterThan(0)
      await manager.deleteManagedSession(randomUUID(), process.cwd()).catch((error) => {
        expect(String(error)).toMatch(/not found|does not exist|unknown session/i)
      })
      const localLogout = await manager.logout()
      expect(localLogout.status.authenticated).toBe(false)

      const secondManager = await realManager()
      const untouchedDefaultIdentity = await secondManager.status({ refresh: true })
      expect(untouchedDefaultIdentity.authenticated).toBe(true)
      expect(untouchedDefaultIdentity.accountFingerprint).toBe(status.accountFingerprint)
    }
  })

  it.skipIf(process.env.MAESTRLY_CLAUDE_QUERY_SMOKE !== '1')(
    'completes an opt-in, tool-free query using the isolated subscription profile',
    async () => {
      const manager = await realManager()
      const status = await manager.status({ refresh: true })
      expect(status.state).toBe('ready')

      const prompt = gatedClaudeHumanText('Reply with exactly OK.')
      const session = manager.createQuery({
        prompt: prompt.prompt,
        options: {
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          tools: [],
          allowedTools: [],
          disallowedTools: ['Agent', 'Task', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'],
          skills: [],
          plugins: [],
          permissionMode: 'dontAsk',
          persistSession: false,
          maxTurns: 1,
          systemPrompt: 'This is an opt-in Maestrly runtime smoke test. Do not use tools.',
        },
      })
      let completed = false
      try {
        const initialized = await session.initializationResult()
        manager.assertSubscriptionRuntimeAccount(initialized.account)
        prompt.release()
        for await (const message of session) {
          if (message.type === 'result' && message.subtype === 'success') completed = true
        }
      } finally {
        prompt.reject(new Error('Smoke query closed before prompt release.'))
        session.close()
      }
      expect(completed).toBe(true)
    },
    120_000
  )
})

// Opt-in only. MAESTRLY_CLAUDE_FAILOVER_SLOT_A / _SLOT_B are existing named account IDs.
// MAESTRLY_CLAUDE_FAILOVER_USER_DATA must point to the existing Maestrly user-data directory.
// This never logs in/out, changes credentials, or persists query sessions.
it.skipIf(process.env.MAESTRLY_CLAUDE_FAILOVER_SMOKE !== '1')(
  'runs two existing distinct Claude slots with injected quota between tool-free queries',
  async () => {
    const { vi } = await import('vitest')
    const adapter = await import('../../src/main/chat/subscription-failover/claude-adapter')
    const { runClaudeEphemeralWithFailover } = await import(
      '../../src/main/chat/subscription-failover/claude-ephemeral'
    )
    const { summarizeWithClaudeRuntime, isolatedSummaryAttemptUsage, mergeIsolatedSummaryUsage } = await import(
      '../../src/main/chat/portable-summarizer'
    )
    const userData = process.env.MAESTRLY_CLAUDE_FAILOVER_USER_DATA
    const slots = [process.env.MAESTRLY_CLAUDE_FAILOVER_SLOT_A, process.env.MAESTRLY_CLAUDE_FAILOVER_SLOT_B]
    expect(userData).toBeTruthy()
    for (const slot of slots) expect(slot).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(slots[0]).not.toBe(slots[1])
    const signal = AbortSignal.timeout(120_000)
    const targets: import('../../src/main/chat/subscription-failover/claude-adapter').ClaudeRuntimeTarget[] = []
    for (const accountId of slots) {
      const manager = new ClaudeSubscriptionManager({ getUserDataPath: () => userData!, accountId })
      managers.push(manager)
      const status = await manager.status({ refresh: true })
      expect(status.authenticated).toBe(true)
      expect(status.accountFingerprint).toBeTruthy()
      const models = await manager.listModels(signal)
      const model = targets.length
        ? models.find((m) => (m.resolvedModel ?? m.value) === targets[0].runtimeModelId)
        : models[0]
      expect(model).toBeTruthy()
      targets.push({
        manager,
        accountId: accountId!,
        providerId: `builtin_claude_subscription@${accountId}`,
        accountIdentity: { fingerprint: status.accountFingerprint, epoch: status.accountEpoch },
        model: model!,
        runtimeModelId: model!.resolvedModel ?? model!.value,
        fastMode: false,
        maestrlyUltra: false,
        contextWindow: null,
      })
    }
    expect(targets[0].accountIdentity.fingerprint).not.toBe(targets[1].accountIdentity.fingerprint)
    // Inject admission and settlement locally so artificial quota never poisons the application's router.
    const resolve = vi.spyOn(adapter, 'resolveClaudeRuntimeTarget').mockImplementation(async (args) => ({
      ok: true,
      target: targets.find((t) => !args.attemptedProviderIds.has(t.providerId))!,
    }))
    const settle = vi.spyOn(adapter, 'settleClaudeAttempt').mockImplementation(() => {})
    const observations: unknown[] = []
    const marker = `continuity-${randomUUID()}`
    let priorAnswer = ''
    try {
      const result = await runClaudeEphemeralWithFailover({
        logicalProviderId: targets[0].providerId,
        modelId: targets[0].runtimeModelId,
        chain: targets.map((t) => t.providerId),
        signal,
        extractAttemptUsage: isolatedSummaryAttemptUsage,
        mergeAttemptUsage: mergeIsolatedSummaryUsage,
        onAttemptUsage: (info) => observations.push(info),
        operation: async (target, operationSignal) => {
          const result = await summarizeWithClaudeRuntime({
            manager: target.manager,
            accountIdentity: target.accountIdentity,
            cwd: process.cwd(),
            modelId: target.runtimeModelId,
            system: 'Reply briefly. Do not use tools.',
            prompt:
              target.providerId === targets[0].providerId
                ? `Reply with exactly ${marker}.`
                : `Previous assistant context from the same task:\n${priorAnswer}\nRepeat the exact continuity marker from that context, and nothing else.`,
            signal: operationSignal,
            fastMode: false,
          })
          if (target.providerId === targets[0].providerId) {
            expect(result.text).toContain(marker)
            priorAnswer = result.text
            throw Object.assign(new Error("You've hit your limit"), {
              partialUsage: result.usage,
              runtimeEstimatedCostUsd: result.runtimeEstimatedCostUsd,
            })
          }
          return result
        },
      })
      expect(result.text).toContain(marker)
      expect(observations).toHaveLength(2)
      expect(settle.mock.calls.map((call) => call[1])).toEqual(['quota', 'success'])
    } finally {
      resolve.mockRestore()
      settle.mockRestore()
    }
  },
  150_000
)
