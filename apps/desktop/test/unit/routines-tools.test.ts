import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import type { StandaloneConversation } from '../../src/shared/conversation'
import type { RoutineDraft } from '../../src/shared/routines'
import { ALL_TOOL_NAMES, builtinToolNamesForMode, isOptInToolName, selectSubagentToolNames } from '../../src/main/chat/tools'
import { insertConversation, patchConvUiPrefs } from '../../src/main/store'
import { registerRemoteChatPolicy } from '../../src/main/chat/remote-policy'
import { registerAutonomousConversation } from '../../src/main/chat/autonomous'
import { createRoutine, getProposal, getRun, insertRun } from '../../src/main/routines/store'
import { routineProposeTool, enableRoutineTools } from '../../src/main/chat/tools/routine-propose'
import { routineRunReportTool } from '../../src/main/chat/tools/routine-run-report'
import type { ToolContext } from '../../src/main/chat/tools/util'

beforeEach(freshDb)
afterEach(() => {
  vi.unstubAllEnvs()
  closeDb()
})

function ctx(conversationId: string): ToolContext {
  return {
    conversationId,
    projectId: null,
    messageId: 'm1',
    toolCallId: 'tc1',
    cwd: '/tmp/chat',
    signal: new AbortController().signal,
    ask: async () => {},
    askQuestion: async () => [],
  }
}

function makeConv(overrides: Partial<StandaloneConversation> = {}): StandaloneConversation {
  const conv: StandaloneConversation = {
    id: overrides.id ?? 'conv-1',
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: 'Test chat',
    cwd: '/tmp/chat',
    status: 'idle',
    createdAt: 1000,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1000,
    ...overrides,
  }
  insertConversation(conv)
  return conv
}

function sampleDraft(): RoutineDraft {
  return {
    title: 'Daily digest',
    instruction: 'Check open PRs.',
    schedule: { kind: 'weekly', time: '09:00', days: [], timezone: 'UTC' },
    permMode: 'auto',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5', reasoning: 'medium', fastMode: false },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
  }
}

describe('routine agent tools registration & gates', () => {
  it('registers routine_propose and routine_run_report as parent-only opt-in built-ins', () => {
    expect(ALL_TOOL_NAMES).toContain('routine_propose')
    expect(ALL_TOOL_NAMES).toContain('routine_run_report')
    expect(isOptInToolName('routine_propose')).toBe(true)
    expect(isOptInToolName('routine_run_report')).toBe(true)

    const worker = selectSubagentToolNames({
      definition: { name: 'general-purpose', source: 'built-in' },
      readOnly: false,
      providedHostTools: new Set(['routine_propose', 'routine_run_report']),
    })
    expect(worker.has('routine_propose')).toBe(false)
    expect(worker.has('routine_run_report')).toBe(false)
  })

  it('gates routine_propose to local non-run, non-remote, non-autonomous conversations and inherits mode/model', async () => {
    const conv = makeConv({ id: 'conv-local' })
    patchConvUiPrefs(conv.id, {
      chat: {
        mode: 'agent',
        permMode: 'auto',
        providerId: 'openai',
        modelId: 'gpt-5',
        reasoning: 'high',
        fastMode: true,
      },
    })

    const enabled = builtinToolNamesForMode('agent')
    enableRoutineTools(enabled, conv.id)
    expect(enabled.has('routine_propose')).toBe(true)
    expect(enabled.has('routine_run_report')).toBe(false)

    const res = await routineProposeTool.execute(
      {
        title: 'PR monitor',
        instruction: 'Check open pull requests every morning.',
        schedule: { kind: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5], timezone: 'America/Sao_Paulo' },
      },
      ctx(conv.id)
    )
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected ok')
    expect(res.draft.permMode).toBe('auto')
    expect(res.draft.model).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5',
      reasoning: 'high',
      fastMode: true,
    })
    expect(res.draft.retentionDays).toBe(30)
    expect(getProposal(res.proposalId)?.state).toBe('pending')

    const modelText = routineProposeTool.toModelText({} as never, res)
    expect(modelText).toContain('does NOT exist yet')

    // Remote web chat gate
    const remoteConv = makeConv({ id: 'conv-remote' })
    const releaseRemote = registerRemoteChatPolicy({
      conversationId: remoteConv.id,
      mode: 'agent',
      permMode: 'ask',
      cwd: '/tmp/chat',
      providerIds: [],
      allowCommands: false,
      allowWeb: false,
      allowAppTools: false,
      allowMcp: false,
    })
    try {
      const remoteEnabled = builtinToolNamesForMode('agent')
      enableRoutineTools(remoteEnabled, remoteConv.id)
      expect(remoteEnabled.has('routine_propose')).toBe(false)
      const denied = await routineProposeTool.execute(
        {
          title: 'X',
          instruction: 'Y',
          schedule: { kind: 'interval', every_minutes: 30 },
        },
        ctx(remoteConv.id)
      )
      expect(denied.ok).toBe(false)
    } finally {
      releaseRemote()
    }

    // Autonomous turn gate
    const autoConv = makeConv({ id: 'conv-auto' })
    const releaseAuto = registerAutonomousConversation(autoConv.id, {
      cwd: '/tmp',
      providerIds: [],
      allowCommands: false,
      allowWeb: false,
      allowAppTools: false,
      allowMcp: false,
      allowPush: false,
    })
    try {
      const autoEnabled = builtinToolNamesForMode('agent')
      enableRoutineTools(autoEnabled, autoConv.id)
      expect(autoEnabled.has('routine_propose')).toBe(false)
    } finally {
      releaseAuto()
    }

    // Bot / headless gate
    vi.stubEnv('MAESTRLY_BOT_MODE', '1')
    const botEnabled = builtinToolNamesForMode('agent')
    enableRoutineTools(botEnabled, conv.id)
    expect(botEnabled.has('routine_propose')).toBe(false)
  })

  it('exposes routine_run_report only in run conversations and saves report onto the run', async () => {
    const routine = createRoutine(sampleDraft(), null, 1000)
    const run = insertRun({
      routineId: routine.id,
      scheduledAt: 1000,
      startedAt: 1000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'running',
      summary: null,
      report: null,
      error: null,
      conversationId: 'conv-run-1',
      conversationDeleted: false,
      pinned: false,
      unread: false,
    })
    makeConv({
      id: 'conv-run-1',
      routineId: routine.id,
      routineRunId: run.id,
    })

    const enabled = builtinToolNamesForMode('agent')
    enableRoutineTools(enabled, 'conv-run-1')
    expect(enabled.has('routine_run_report')).toBe(true)
    expect(enabled.has('routine_propose')).toBe(false)

    const result = await routineRunReportTool.execute(
      {
        outcome: 'notable',
        summary: '2 PRs need review',
        pending: 'Review PR #42',
        notes_for_next_run: 'Check CI status on #43',
      },
      ctx('conv-run-1')
    )
    expect(result).toEqual({ reported: true })
    expect(getRun(run.id)?.report).toEqual({
      outcome: 'notable',
      summary: '2 PRs need review',
      pending: 'Review PR #42',
      notes: 'Check CI status on #43',
    })

    // Refuses in normal conversations
    const normal = makeConv({ id: 'conv-normal' })
    const refused = await routineRunReportTool.execute(
      { outcome: 'done', summary: 'Should fail' },
      ctx(normal.id)
    )
    expect(refused).toMatchObject({ reported: false })
  })
})
