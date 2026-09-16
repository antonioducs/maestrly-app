import { randomUUID } from 'node:crypto'
import { TEAM_LIMITS, teamPolicySchema, type Bot, type Team, type TeamArtifact, type TeamConversation, type TeamEvent, type TeamMember, type TeamMemory, type TeamMessage, type TeamOperation, type TeamRun, type TeamTask } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'

const now = () => new Date().toISOString()
const fail = (code: string, message: string) => new HostRequestError(message, code)

/**
 * Development-only in-memory teams domain for UI work. It mirrors the Host's rules that the
 * interface depends on — one run per team, a coordinator that plans, members that work,
 * one consolidated answer, explicit sharing — and nothing else. Never hardware evidence,
 * never shipped: the packaged runtime has no fixtures at all.
 */
export class FixtureTeams {
  teams = new Map<string, Team>()
  members = new Map<string, TeamMember[]>()
  conversations = new Map<string, TeamConversation>()
  messages = new Map<string, TeamMessage[]>()
  runs = new Map<string, TeamRun>()
  tasks = new Map<string, TeamTask[]>()
  memories = new Map<string, TeamMemory[]>()
  artifacts = new Map<string, TeamArtifact[]>()
  operations = new Map<string, TeamOperation>()
  keys = new Map<string, TeamOperation>()
  events: TeamEvent[] = []
  private sequence = 0
  constructor(private readonly bot: (id: string) => Bot | undefined) {}

  private event(teamId: string, kind: TeamEvent['kind'], summary: string, detail?: Record<string, unknown>, runId?: string, botId?: string) {
    this.events.push({ seq: ++this.sequence, teamId, kind, summary, ...(runId ? { runId } : {}), ...(botId ? { botId } : {}), ...(detail ? { detail } : {}), createdAt: now() })
  }
  private details(teamId: string) {
    const team = this.teams.get(teamId)
    if (!team) throw fail('TEAM_NOT_FOUND', 'Esta equipe não existe')
    const conversation = this.conversations.get(team.conversationId)!
    const active = [...this.runs.values()].find((run) => run.conversationId === conversation.id && !['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status))
    return { team, members: this.members.get(teamId) ?? [], conversation, activeRun: active ?? null }
  }
  private nameOf(botId: string) {
    return this.bot(botId)?.name ?? 'Membro'
  }

  /** Advances the fixture run the way the Host would, so the UI sees a real sequence. */
  private advance(runId: string) {
    const run = this.runs.get(runId)
    if (!run || ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status)) return
    const tasks = this.tasks.get(runId) ?? []
    const work = tasks.filter((task) => task.kind === 'work')
    if (run.status === 'planning') {
      // The coordinator hands out one batch and releases its slot.
      const members = (this.members.get(run.teamId) ?? []).filter((member) => !member.coordinator)
      const batch = members.slice(0, 2).map((member, index) => ({
        id: randomUUID(),
        runId,
        teamId: run.teamId,
        round: 1,
        localKey: `t${index + 1}`,
        kind: 'work' as const,
        assigneeBotId: member.botId,
        memberId: member.id,
        goal: index === 0 ? 'Analisar os dados do pedido' : 'Escrever o texto do resultado',
        acceptanceCriteria: '',
        dependsOn: [],
        inputArtifactIds: [],
        useDependencyOutputs: true,
        origin: 'coordinator' as const,
        status: 'running' as const,
        attempts: 1,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }))
      this.tasks.set(runId, [...tasks, ...batch])
      this.runs.set(runId, { ...run, status: 'working', round: 1, budget: { ...run.budget, rounds: 1, tasks: batch.length, turns: run.budget.turns + batch.length }, revision: run.revision + 1, updatedAt: now() })
      this.event(run.teamId, 'delegation.submitted', `${this.nameOf(run.coordinatorBotId)} distribuiu ${batch.length} tarefa(s)`, { round: 1 }, runId, run.coordinatorBotId)
      for (const task of batch) this.event(run.teamId, 'task.status', `${this.nameOf(task.assigneeBotId)} começou a trabalhar`, { status: 'running' }, runId, task.assigneeBotId)
      return
    }
    if (run.status === 'working') {
      const running = work.find((task) => task.status === 'running')
      if (running) {
        const done: TeamTask = {
          ...running,
          status: 'succeeded',
          result: { summary: running.localKey === 't1' ? 'A soma da coluna valor é 1234.' : 'Recomendo revisar os maiores gastos.', artifacts: [], turnId: randomUUID(), completedAt: now() },
          revision: running.revision + 1,
          updatedAt: now(),
        }
        this.tasks.set(runId, (this.tasks.get(runId) ?? []).map((task) => (task.id === running.id ? done : task)))
        this.event(run.teamId, 'task.status', `${this.nameOf(running.assigneeBotId)} concluiu sua parte`, { status: 'succeeded' }, runId, running.assigneeBotId)
        return
      }
      this.runs.set(runId, { ...run, status: 'reviewing', revision: run.revision + 1, updatedAt: now() })
      this.event(run.teamId, 'run.status', 'A equipe está juntando os resultados', { status: 'reviewing' }, runId)
      return
    }
    if (run.status === 'reviewing') {
      const delivered = work.filter((task) => task.status === 'succeeded')
      const summary = delivered.map((task) => `**${this.nameOf(task.assigneeBotId)}**\n${task.result?.summary ?? ''}`).join('\n\n')
      const conversation = this.conversations.get(run.conversationId)!
      const sequence = conversation.lastSequence + 1
      const message: TeamMessage = {
        id: randomUUID(),
        conversationId: conversation.id,
        clientMessageId: `run-final:${runId}`,
        author: { kind: 'bot', botId: run.coordinatorBotId, name: this.nameOf(run.coordinatorBotId) },
        kind: 'answer',
        content: summary || 'A equipe não produziu um resultado.',
        runId,
        sequence,
        artifacts: [],
        createdAt: now(),
      }
      this.messages.set(conversation.id, [...(this.messages.get(conversation.id) ?? []), message])
      this.conversations.set(conversation.id, { ...conversation, activeRunId: undefined, lastSequence: sequence, revision: conversation.revision + 1, updatedAt: now() })
      const status = delivered.length === work.length ? 'succeeded' : delivered.length ? 'partial' : 'failed'
      this.runs.set(runId, { ...run, status, summary, finishedAt: now(), revision: run.revision + 1, updatedAt: now() })
      this.event(run.teamId, 'run.status', status === 'succeeded' ? 'A equipe concluiu o trabalho' : 'A equipe concluiu parte do trabalho', { status }, runId)
    }
  }

  request(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'team.list':
        return [...this.teams.values()].filter((team) => p.includeArchived === true || team.status !== 'archived')
      case 'team.inspect':
        return this.details(String(p.teamId))
      case 'team.create': {
        const existing = this.keys.get(String(p.idempotencyKey))
        if (existing?.teamId) return this.details(existing.teamId)
        const input = p.members as { botId: string; role?: string; coordinator?: boolean }[]
        if (input.length < 2) throw fail('TEAM_MEMBER_INVALID', 'Uma equipe precisa de pelo menos dois bots')
        if (new Set(input.map((member) => member.botId)).size !== input.length) throw fail('TEAM_MEMBER_INVALID', 'Um bot não pode participar duas vezes')
        const teamId = randomUUID()
        const conversationId = randomUUID()
        const coordinatorBotId = input.find((member) => member.coordinator)?.botId ?? input[0].botId
        const team: Team = {
          id: teamId,
          hostId: 'd9a02e5b-0c12-4411-9393-b5106ecff181',
          name: String(p.name),
          objective: String(p.objective ?? ''),
          coordinatorBotId,
          conversationId,
          status: 'active',
          policy: teamPolicySchema.parse((p.policy as Record<string, unknown>) ?? {}),
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        }
        this.teams.set(teamId, team)
        this.conversations.set(conversationId, { id: conversationId, teamId, title: team.name, lastSequence: 0, revision: 0, createdAt: now(), updatedAt: now() })
        this.members.set(
          teamId,
          input.map((member) => ({
            id: randomUUID(),
            teamId,
            botId: member.botId,
            role: member.role ?? '',
            coordinator: member.botId === coordinatorBotId,
            active: true,
            consentedAt: now(),
            grantRevision: 1,
            createdAt: now(),
            updatedAt: now(),
          }))
        )
        const operation: TeamOperation = { id: randomUUID(), kind: 'team.create', teamId, status: 'succeeded', createdAt: now(), updatedAt: now() }
        this.operations.set(operation.id, operation)
        this.keys.set(String(p.idempotencyKey), operation)
        this.event(teamId, 'membership.changed', 'Equipe criada', { members: input.length })
        return this.details(teamId)
      }
      case 'team.update': {
        const { team } = this.details(String(p.teamId))
        if (team.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'A equipe mudou; recarregue antes de editar')
        this.teams.set(team.id, {
          ...team,
          ...(p.name !== undefined ? { name: String(p.name) } : {}),
          ...(p.objective !== undefined ? { objective: String(p.objective) } : {}),
          revision: team.revision + 1,
          updatedAt: now(),
        })
        return this.details(team.id)
      }
      case 'team.members.set': {
        const { team, activeRun } = this.details(String(p.teamId))
        if (activeRun && p.confirmStopActiveWork !== true) throw fail('TEAM_WORK_IN_PROGRESS', 'Esta equipe tem trabalho em andamento')
        const input = p.members as { botId: string; role?: string; coordinator?: boolean }[]
        const coordinatorBotId = input.find((member) => member.coordinator)?.botId ?? input[0].botId
        const previous = this.members.get(team.id) ?? []
        const grantRevision = Math.max(0, ...previous.map((member) => member.grantRevision)) + 1
        this.members.set(
          team.id,
          input.map((member) => ({
            id: previous.find((entry) => entry.botId === member.botId)?.id ?? randomUUID(),
            teamId: team.id,
            botId: member.botId,
            role: member.role ?? '',
            coordinator: member.botId === coordinatorBotId,
            active: true,
            consentedAt: now(),
            grantRevision,
            createdAt: now(),
            updatedAt: now(),
          }))
        )
        this.teams.set(team.id, { ...team, coordinatorBotId, revision: team.revision + 1, updatedAt: now() })
        this.event(team.id, 'membership.changed', 'Participantes atualizados', { members: input.length })
        return this.details(team.id)
      }
      case 'team.archive': {
        const existing = this.keys.get(String(p.idempotencyKey))
        if (existing) return existing
        const { team, activeRun } = this.details(String(p.teamId))
        if (activeRun) throw fail('TEAM_WORK_IN_PROGRESS', 'Pare o trabalho em andamento antes de arquivar')
        this.teams.set(team.id, { ...team, status: 'archived', revision: team.revision + 1, updatedAt: now() })
        const operation: TeamOperation = { id: randomUUID(), kind: 'team.archive', teamId: team.id, status: 'succeeded', detail: { botsArchived: 0, computersChanged: 0 }, createdAt: now(), updatedAt: now() }
        this.operations.set(operation.id, operation)
        this.keys.set(String(p.idempotencyKey), operation)
        this.event(team.id, 'membership.changed', 'Equipe arquivada', { preserved: true })
        return operation
      }
      case 'team.messages.list': {
        const { team, conversation } = this.details(String(p.teamId))
        const all = this.messages.get(conversation.id) ?? []
        const limit = Number(p.limit ?? 50)
        const before = p.before === undefined ? Number.MAX_SAFE_INTEGER : Number(p.before)
        const page = all.filter((message) => message.sequence < before).slice(-limit)
        const runIds = new Set(page.map((message) => message.runId).filter(Boolean))
        void team
        return { conversation, messages: page, runs: [...this.runs.values()].filter((run) => runIds.has(run.id)), hasMore: all.filter((message) => message.sequence < before).length > page.length }
      }
      case 'team.messages.send': {
        const { team, conversation, activeRun } = this.details(String(p.teamId))
        const existing = (this.messages.get(conversation.id) ?? []).find((message) => message.clientMessageId === p.clientMessageId)
        if (existing?.runId) return { message: existing, run: this.runs.get(existing.runId)! }
        if (activeRun) throw fail('TEAM_RUN_ACTIVE', 'A equipe ainda está trabalhando no pedido anterior')
        const members = this.members.get(team.id) ?? []
        const runId = randomUUID()
        const sequence = conversation.lastSequence + 1
        const message: TeamMessage = {
          id: randomUUID(),
          conversationId: conversation.id,
          clientMessageId: String(p.clientMessageId),
          author: { kind: 'human' },
          kind: 'request',
          content: String(p.content),
          runId,
          sequence,
          artifacts: [],
          createdAt: now(),
        }
        this.messages.set(conversation.id, [...(this.messages.get(conversation.id) ?? []), message])
        const run: TeamRun = {
          id: runId,
          teamId: team.id,
          conversationId: conversation.id,
          messageId: message.id,
          coordinatorBotId: team.coordinatorBotId,
          roster: members.map((member) => ({ memberId: member.id, botId: member.botId, name: this.nameOf(member.botId), role: member.role, coordinator: member.coordinator })),
          resources: [],
          memberGrantRevision: members[0]?.grantRevision ?? 1,
          limits: team.policy,
          budget: { rounds: 0, tasks: 0, turns: 1, toolCallsReserved: 0, toolCallsSettled: 0, activeMsReserved: 0, activeMsSettled: 0, consolidationHeld: true, tokensObserved: false },
          round: 0,
          status: 'planning',
          generation: 1,
          revision: 0,
          createdAt: now(),
          updatedAt: now(),
        }
        this.runs.set(runId, run)
        this.tasks.set(runId, [])
        this.conversations.set(conversation.id, { ...conversation, activeRunId: runId, lastSequence: sequence, revision: conversation.revision + 1, updatedAt: now() })
        this.event(team.id, 'run.status', 'A equipe recebeu o pedido', { status: 'planning' }, runId)
        return { message, run }
      }
      case 'team.messages.lookup': {
        const { conversation } = this.details(String(p.teamId))
        const message = (this.messages.get(conversation.id) ?? []).find((entry) => entry.clientMessageId === p.clientMessageId)
        return message?.runId ? { message, run: this.runs.get(message.runId)! } : null
      }
      case 'team.run.get': {
        const run = this.runs.get(String(p.runId))
        if (!run) throw fail('NOT_FOUND', 'Trabalho não encontrado')
        return run
      }
      case 'team.run.cancel': {
        const run = this.runs.get(String(p.runId))
        if (!run) throw fail('NOT_FOUND', 'Trabalho não encontrado')
        if (run.revision !== p.expectedRevision) throw fail('REVISION_CONFLICT', 'O trabalho mudou')
        const tasks = (this.tasks.get(run.id) ?? []).map((task) => (['succeeded', 'failed'].includes(task.status) ? task : { ...task, status: 'cancelled' as const, revision: task.revision + 1, updatedAt: now() }))
        this.tasks.set(run.id, tasks)
        const cancelled: TeamRun = { ...run, status: 'cancelled', finishedAt: now(), revision: run.revision + 1, updatedAt: now() }
        this.runs.set(run.id, cancelled)
        const conversation = this.conversations.get(run.conversationId)!
        this.conversations.set(conversation.id, { ...conversation, activeRunId: undefined, revision: conversation.revision + 1, updatedAt: now() })
        this.event(run.teamId, 'run.status', 'Trabalho interrompido', { status: 'cancelled' }, run.id)
        return cancelled
      }
      case 'team.tasks.list': {
        const run = this.runs.get(String(p.runId))
        if (!run) throw fail('NOT_FOUND', 'Trabalho não encontrado')
        // Reading the work also nudges the fixture forward, so the UI sees real progress.
        this.advance(run.id)
        return { run: this.runs.get(run.id)!, tasks: this.tasks.get(run.id) ?? [], turns: [] }
      }
      case 'team.events.list': {
        const after = Number(p.after ?? 0)
        const limit = Number(p.limit ?? 100)
        const all = this.events.filter((event) => event.teamId === p.teamId && event.seq > after)
        const page = all.slice(0, limit)
        return { events: page, cursor: page.at(-1)?.seq ?? after, hasMore: all.length > page.length }
      }
      case 'team.memory.list':
        return (this.memories.get(String(p.teamId)) ?? []).filter((memory) => memory.status === 'active')
      case 'team.memory.proposals':
        return (this.memories.get(String(p.teamId)) ?? []).filter((memory) => memory.status === 'proposed')
      case 'team.memory.upsert': {
        const teamId = String(p.teamId)
        const list = this.memories.get(teamId) ?? []
        const memory: TeamMemory = { id: randomUUID(), teamId, content: String(p.content), origin: 'user', status: 'active', version: 1, revision: 0, createdAt: now(), updatedAt: now() }
        this.memories.set(teamId, [...list, memory])
        this.event(teamId, 'memory.changed', 'Memória da equipe atualizada', { memoryId: memory.id })
        return memory
      }
      case 'team.memory.remove': {
        const teamId = String(p.teamId)
        const list = this.memories.get(teamId) ?? []
        const memory = list.find((entry) => entry.id === p.memoryId)
        if (!memory) throw fail('NOT_FOUND', 'Memória não encontrada')
        const removed: TeamMemory = { ...memory, status: 'removed', revision: memory.revision + 1, updatedAt: now() }
        this.memories.set(teamId, list.map((entry) => (entry.id === memory.id ? removed : entry)))
        return removed
      }
      case 'team.memory.decide': {
        const teamId = String(p.teamId)
        const list = this.memories.get(teamId) ?? []
        const memory = list.find((entry) => entry.id === p.memoryId)
        if (!memory) throw fail('NOT_FOUND', 'Memória não encontrada')
        const decided: TeamMemory = { ...memory, status: p.decision === 'approve' ? 'active' : 'removed', revision: memory.revision + 1, updatedAt: now() }
        this.memories.set(teamId, list.map((entry) => (entry.id === memory.id ? decided : entry)))
        return decided
      }
      case 'team.artifacts.list':
        return (this.artifacts.get(String(p.teamId)) ?? []).filter((artifact) => p.includeRevoked === true || artifact.state === 'available')
      case 'team.artifacts.revoke': {
        const teamId = String(p.teamId)
        const list = this.artifacts.get(teamId) ?? []
        const artifact = list.find((entry) => entry.id === p.artifactId)
        if (!artifact) throw fail('NOT_FOUND', 'Arquivo não encontrado')
        const revoked: TeamArtifact = { ...artifact, state: 'revoked', revokedAt: now(), updatedAt: now() }
        this.artifacts.set(teamId, list.map((entry) => (entry.id === artifact.id ? revoked : entry)))
        this.event(teamId, 'artifact.revoked', 'Acesso revogado; as cópias já entregues não podem ser apagadas remotamente', { artifactId: artifact.id, deliveredCopies: 1 })
        return revoked
      }
      case 'team.operation.get': {
        const operation = this.operations.get(String(p.operationId))
        if (!operation) throw fail('NOT_FOUND', 'Operação não encontrada')
        return operation
      }
      case 'team.operation.lookup':
        return this.keys.get(String(p.idempotencyKey)) ?? null
    }
    throw fail('INVALID_REQUEST', `Fixture does not implement ${method}`)
  }
}
export { TEAM_LIMITS }
