import { createHash, randomUUID } from 'node:crypto'
import { statfsSync } from 'node:fs'
import {
  TEAM_LIMITS,
  TEAM_MUTATIONS,
  TEAM_RUN_TERMINAL,
  TRANSFER_CHUNK_BYTES,
  teamPolicySchema,
  teamResultSchemas,
  type Bot,
  type CollaborationRequest,
  type Team,
  type TeamArtifactRef,
  type TeamConversation,
  type TeamMember,
  type TeamMessage,
  type TeamMethod,
  type TeamOperation,
  type TeamRequest,
  type TeamResult,
  type TeamRun,
  type TeamTransferState,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import { workspacePath } from '../bots/files.js'
import type { BotTurns } from '../bots/turns.js'
import type { RuntimeCoordinator } from '../bots/runtime-coordinator.js'
import type { GuestSession } from '../guest/session.js'
import { TeamAccess } from './access.js'
import { TeamArtifacts } from './artifacts.js'
import { TeamBudgets, emptyBudget } from './budgets.js'
import { TeamGuestTools } from './guest-tools.js'
import { TeamMemories } from './memory.js'
import { TeamRepository, now } from './repository.js'
import { TeamScheduler } from './scheduler.js'
import { TeamSharing } from './sharing.js'
import { TeamTurnAdapter } from './turn-adapter.js'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
/** Idempotency fingerprint covers content, attachments, recipients and scope, not just text. */
export const teamFingerprint = (params: unknown) => createHash('sha256').update(canonical(params)).digest('hex')
const TRANSFER_TTL_MS = 30 * 60_000

export interface TeamServiceOptions {
  repo: BotRepository
  teams: TeamRepository
  turns: BotTurns
  coordinator: RuntimeCoordinator
  hostId: string
  stateDirectory: string
  session: (bot: Bot) => Promise<GuestSession>
  held: (botId: string) => boolean
}

/**
 * Team domain façade delegated to by HostService. Teams only link bots that already exist:
 * nothing here creates an account, duplicates a bot, changes a VM, installs a guest, turns a
 * computer on or raises a quota.
 */
export class TeamService {
  readonly repo: TeamRepository
  readonly access: TeamAccess
  readonly budgets: TeamBudgets
  readonly artifacts: TeamArtifacts
  readonly sharing: TeamSharing
  readonly memories: TeamMemories
  readonly adapter: TeamTurnAdapter
  readonly scheduler: TeamScheduler
  readonly tools: TeamGuestTools
  constructor(private readonly options: TeamServiceOptions) {
    this.repo = options.teams
    this.access = new TeamAccess(this.repo, options.repo)
    this.budgets = new TeamBudgets()
    this.artifacts = new TeamArtifacts({
      teams: this.repo,
      bots: options.repo,
      stateDirectory: options.stateDirectory,
      session: options.session,
      freeBytes: () => {
        try {
          const info = statfsSync(options.stateDirectory)
          return Number(info.bavail) * Number(info.bsize)
        } catch {
          return Number.MAX_SAFE_INTEGER
        }
      },
    })
    this.sharing = new TeamSharing(this.repo, this.artifacts)
    this.memories = new TeamMemories(this.repo)
    this.adapter = new TeamTurnAdapter({ repo: options.repo, teams: this.repo, turns: options.turns, coordinator: options.coordinator, budgets: this.budgets })
    this.scheduler = new TeamScheduler({
      teams: this.repo,
      bots: options.repo,
      access: this.access,
      adapter: this.adapter,
      budgets: this.budgets,
      sharing: this.sharing,
      artifacts: this.artifacts,
      coordinator: options.coordinator,
    })
    this.tools = new TeamGuestTools({
      teams: this.repo,
      bots: options.repo,
      access: this.access,
      scheduler: this.scheduler,
      artifacts: this.artifacts,
      memories: this.memories,
    })
    options.turns.setContinuationScope(this.adapter)
  }
  ready() {
    this.scheduler.recover()
    this.scheduler.start()
  }
  async close() {
    await this.scheduler.close()
  }
  isMutation(method: TeamMethod) {
    return TEAM_MUTATIONS.includes(method)
  }
  /** A collaboration frame from a guest never reaches the public team.* dispatcher. */
  collaboration(botId: string, request: CollaborationRequest) {
    return this.tools.handle(botId, request)
  }
  /** Turn changes are mirrored onto the team task that owns them, if any. */
  turnChanged(turnId: string) {
    this.scheduler.applyTurnEvent(turnId)
  }
  /** Outcome of a desktop return for a member that was working on a team task. */
  handoffReturned(input: { interruptedTurnId?: string; continuationTurnId?: string; failureCode?: string }) {
    this.scheduler.handoffReturned(input)
  }
  /**
   * The parcel the interrupted task reserved. A continuation may use what is left of it and
   * nothing more: a takeover must not hand a member a fresh standalone allowance.
   */
  budgetCeiling(turnId: string): { activeMs: number; maxTools: number } | undefined {
    const attempt = this.repo.attemptByTurn(turnId)
    if (!attempt) return undefined
    const root = this.repo.attempts(attempt.taskId).find((candidate) => candidate.reservedToolCalls > 0)
    if (!root) return undefined
    return { activeMs: root.reservedActiveMs, maxTools: root.reservedToolCalls }
  }
  /**
   * Last check before a queued team turn is written to a guest. A membership, grant or
   * policy that was reduced after admission blocks the old outbox item instead of running.
   */
  dispatchGuard(turnId: string): { code: string; message: string } | undefined {
    const attempt = this.repo.attemptByTurn(turnId)
    if (!attempt) return undefined
    try {
      const run = this.repo.run(attempt.runId)
      if (TEAM_RUN_TERMINAL.has(run.status) || run.status === 'cancelling')
        return { code: 'TEAM_STAGE_INVALID', message: 'Este trabalho de equipe foi encerrado antes desta execução começar.' }
      const team = this.repo.team(run.teamId)
      if (team.status === 'archived') return { code: 'TEAM_ARCHIVED', message: 'A equipe foi arquivada antes desta execução começar.' }
      const member = this.repo.member(run.teamId, attempt.botId)
      if (!member?.active || member.grantRevision !== run.memberGrantRevision)
        return { code: 'TEAM_GRANT_REVOKED', message: 'A composição da equipe mudou; esta execução não foi iniciada.' }
      return undefined
    } catch (error) {
      return { code: error instanceof HostError ? error.code : 'TEAM_STAGE_INVALID', message: 'Não foi possível confirmar a autorização desta execução.' }
    }
  }

  private details(teamId: string) {
    const team = this.repo.team(teamId)
    const conversation = this.repo.conversation(team.conversationId)
    return { team, members: this.repo.members(teamId), conversation, activeRun: this.repo.activeRun(conversation.id) ?? null }
  }
  private operation(kind: TeamOperation['kind'], patch: Partial<TeamOperation> = {}): TeamOperation {
    return { id: randomUUID(), kind, status: 'succeeded', createdAt: now(), updatedAt: now(), ...patch }
  }
  private idempotent(key: string, params: unknown) {
    const existing = this.repo.operationByKey(key)
    if (!existing) return undefined
    if (existing.fingerprint !== teamFingerprint(params)) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada com outros parâmetros')
    return existing.operation
  }

  async handle<M extends TeamMethod>(request: Extract<TeamRequest, { method: M }>): Promise<TeamResult<M>> {
    const result = await this.dispatch(request as TeamRequest)
    return teamResultSchemas[request.method].parse(result) as TeamResult<M>
  }

  private async dispatch(request: TeamRequest): Promise<unknown> {
    const p = request.params as any
    switch (request.method) {
      case 'team.list':
        return this.repo.teams(p.includeArchived)
      case 'team.inspect':
        return this.details(p.teamId)
      case 'team.create': {
        const existing = this.idempotent(p.idempotencyKey, p)
        if (existing?.teamId) return this.details(existing.teamId)
        const { coordinatorBotId } = this.access.validateMembers(p.members)
        const created = this.repo.transaction(() => {
          const teamId = randomUUID()
          const conversationId = randomUUID()
          const team: Team = {
            id: teamId,
            hostId: this.options.hostId,
            name: p.name,
            objective: p.objective,
            coordinatorBotId,
            conversationId,
            status: 'active',
            policy: teamPolicySchema.parse(p.policy ?? {}),
            revision: 0,
            createdAt: now(),
            updatedAt: now(),
          }
          this.repo.saveTeam(team)
          const conversation: TeamConversation = { id: conversationId, teamId, title: p.name, lastSequence: 0, revision: 0, createdAt: now(), updatedAt: now() }
          this.repo.saveConversation(conversation)
          for (const member of p.members) this.repo.saveMember(this.newMember(teamId, member, coordinatorBotId, 1))
          this.repo.insertOperation(this.operation('team.create', { teamId }), p.idempotencyKey, teamFingerprint(p), p)
          this.scheduler.event({ teamId, kind: 'membership.changed', summary: 'Equipe criada', detail: { members: p.members.length } })
          return teamId
        })
        return this.details(created)
      }
      case 'team.update': {
        const team = this.access.team(p.teamId)
        if (p.policy?.permissionMode === 'full-vm' && !p.confirmFullVm)
          throw new HostError('CONFIRMATION_REQUIRED', 'O controle administrativo completo exige confirmação explícita')
        this.repo.transaction(() => {
          const current = this.repo.team(team.id)
          if (current.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A equipe mudou; recarregue antes de editar')
          if (p.coordinatorBotId) this.access.member(team.id, p.coordinatorBotId)
          const updated: Team = {
            ...current,
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.objective !== undefined ? { objective: p.objective } : {}),
            // A new coordinator and new limits apply to the next piece of work, never to a
            // run that is already using the roster it started with.
            ...(p.coordinatorBotId ? { coordinatorBotId: p.coordinatorBotId } : {}),
            ...(p.policy ? { policy: teamPolicySchema.parse({ ...current.policy, ...p.policy }) } : {}),
            revision: current.revision + 1,
            updatedAt: now(),
          }
          this.repo.saveTeam(updated)
          if (p.coordinatorBotId)
            for (const member of this.repo.members(team.id))
              this.repo.saveMember({ ...member, coordinator: member.botId === p.coordinatorBotId, updatedAt: now() })
        })
        return this.details(team.id)
      }
      case 'team.archive': {
        const existing = this.idempotent(p.idempotencyKey, p)
        if (existing) return existing
        const team = this.access.team(p.teamId, true)
        const affected = this.access.affectedRuns(team.id)
        if (affected.length) throw new HostError('TEAM_WORK_IN_PROGRESS', `Pare os ${affected.length} trabalho(s) em andamento antes de arquivar a equipe.`)
        return this.repo.transaction(() => {
          const current = this.repo.team(team.id)
          if (current.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A equipe mudou; recarregue antes de arquivar')
          // Archiving preserves the team's history and never archives a bot or a computer.
          this.repo.saveTeam({ ...current, status: 'archived', revision: current.revision + 1, updatedAt: now() })
          const operation = this.operation('team.archive', { teamId: team.id, detail: { botsArchived: 0, computersChanged: 0 } })
          this.repo.insertOperation(operation, p.idempotencyKey, teamFingerprint(p), p)
          this.scheduler.event({ teamId: team.id, kind: 'membership.changed', summary: 'Equipe arquivada', detail: { preserved: true } })
          return operation
        })
      }
      case 'team.members.set': {
        const existing = this.idempotent(p.idempotencyKey, p)
        if (existing?.teamId) return this.details(existing.teamId)
        const team = this.access.team(p.teamId)
        const { coordinatorBotId } = this.access.validateMembers(p.members)
        const affected = this.access.assertQuiet(team.id, p.confirmStopActiveWork)
        for (const run of affected) await this.scheduler.cancel(run.id, run.revision).catch(() => {})
        this.repo.transaction(() => {
          const current = this.repo.team(team.id)
          if (current.revision !== p.expectedRevision) throw new HostError('REVISION_CONFLICT', 'A equipe mudou; recarregue antes de editar')
          const previous = this.repo.members(team.id)
          const grantRevision = Math.max(0, ...previous.map((member) => member.grantRevision)) + 1
          const keep = new Set<string>(p.members.map((member: { botId: string }) => member.botId))
          for (const member of previous) if (!keep.has(member.botId)) this.repo.removeMember(member.id)
          for (const member of p.members) {
            const old = previous.find((candidate) => candidate.botId === member.botId)
            this.repo.saveMember({ ...this.newMember(team.id, member, coordinatorBotId, grantRevision), ...(old ? { id: old.id, createdAt: old.createdAt } : {}) })
          }
          this.repo.saveTeam({ ...current, coordinatorBotId, revision: current.revision + 1, updatedAt: now() })
          this.repo.insertOperation(this.operation('team.members.set', { teamId: team.id }), p.idempotencyKey, teamFingerprint(p), p)
          this.scheduler.event({ teamId: team.id, kind: 'membership.changed', summary: 'Participantes atualizados', detail: { members: p.members.length, grantRevision } })
        })
        return this.details(team.id)
      }
      case 'team.messages.list': {
        const team = this.access.team(p.teamId, true)
        const conversation = this.repo.conversation(team.conversationId)
        const messages = this.repo.messages(conversation.id, p.before, p.limit + 1)
        const page = messages.length > p.limit ? messages.slice(1) : messages
        const runIds = [...new Set(page.map((message) => message.runId).filter((id): id is string => !!id))]
        return { conversation, messages: page, runs: this.repo.runsByIds(runIds), hasMore: messages.length > p.limit }
      }
      case 'team.messages.send':
        return this.send(p)
      case 'team.messages.lookup': {
        const team = this.access.team(p.teamId, true)
        const message = this.repo.messageByClientId(team.conversationId, p.clientMessageId)
        if (!message?.runId) return null
        return { message, run: this.repo.run(message.runId) }
      }
      case 'team.run.get':
        return this.repo.run(p.runId)
      case 'team.run.cancel': {
        const existing = this.idempotent(p.idempotencyKey, p)
        if (existing?.runId) return this.repo.run(existing.runId)
        const run = this.repo.run(p.runId)
        this.repo.transaction(() => this.repo.insertOperation(this.operation('team.run.cancel', { teamId: run.teamId, runId: run.id }), p.idempotencyKey, teamFingerprint(p), p))
        return this.scheduler.cancel(p.runId, p.expectedRevision)
      }
      case 'team.tasks.list': {
        const run = this.repo.run(p.runId)
        const tasks = this.repo.tasks(run.id)
        const turns = this.repo
          .attemptsOfRun(run.id)
          .map((attempt) => {
            try {
              return this.options.repo.turn(attempt.turnId)
            } catch {
              return undefined
            }
          })
          .filter((turn): turn is NonNullable<typeof turn> => !!turn)
        return { run, tasks, turns }
      }
      case 'team.events.list': {
        this.access.team(p.teamId, true)
        const page = this.repo.events(p.teamId, p.after, p.limit)
        return { events: page.events, cursor: page.events.at(-1)?.seq ?? p.after, hasMore: page.hasMore }
      }
      case 'team.memory.list':
        this.access.team(p.teamId, true)
        return this.memories.list(p.teamId, p.includeInactive)
      case 'team.memory.upsert': {
        this.access.team(p.teamId)
        const memory = this.memories.upsert(p.teamId, p)
        this.scheduler.event({ teamId: p.teamId, kind: 'memory.changed', summary: 'Memória da equipe atualizada', detail: { memoryId: memory.id, version: memory.version } })
        return memory
      }
      case 'team.memory.remove': {
        this.access.team(p.teamId)
        const memory = this.memories.remove(p.teamId, p.memoryId, p.expectedRevision)
        this.scheduler.event({ teamId: p.teamId, kind: 'memory.changed', summary: 'Memória removida das próximas tarefas', detail: { memoryId: memory.id } })
        return memory
      }
      case 'team.memory.proposals':
        this.access.team(p.teamId, true)
        return this.memories.proposals(p.teamId)
      case 'team.memory.decide': {
        this.access.team(p.teamId)
        const memory = this.memories.decide(p.teamId, p.memoryId, p.expectedRevision, p.decision)
        this.scheduler.event({
          teamId: p.teamId,
          kind: 'memory.changed',
          summary: p.decision === 'approve' ? 'Sugestão aprovada como memória da equipe' : 'Sugestão descartada',
          detail: { memoryId: memory.id, decision: p.decision },
        })
        return memory
      }
      case 'team.artifacts.list':
        this.access.team(p.teamId, true)
        return this.repo.artifacts(p.teamId, p.includeRevoked)
      case 'team.artifacts.share': {
        const existing = this.idempotent(p.idempotencyKey, p)
        if (existing) return existing
        const team = this.access.team(p.teamId)
        this.access.member(team.id, p.botId)
        // A malformed path is a rejected request, not a durable operation to consult later.
        workspacePath(p.path)
        const operation = this.operation('team.artifact.share', { teamId: team.id, status: 'running', detail: { botId: p.botId } })
        this.repo.transaction(() => this.repo.insertOperation(operation, p.idempotencyKey, teamFingerprint(p), p))
        try {
          const artifact = await this.artifacts.publish({
            teamId: team.id,
            bot: this.options.repo.bot(p.botId),
            path: p.path,
            name: p.name ?? p.path,
            origin: { kind: 'human' },
          })
          const done: TeamOperation = {
            ...operation,
            status: 'succeeded',
            detail: { botId: p.botId, artifactId: artifact.id, name: artifact.name, digest: artifact.digest, size: artifact.size },
            updatedAt: now(),
          }
          this.repo.transaction(() => this.repo.saveOperation(done))
          this.scheduler.event({ teamId: team.id, kind: 'artifact.shared', summary: `Arquivo ${artifact.name} compartilhado com a equipe`, detail: { artifactId: artifact.id, origin: 'human' } })
          return done
        } catch (error) {
          const failed: TeamOperation = {
            ...operation,
            status: 'failed',
            error: { code: error instanceof HostError ? error.code : 'TRANSFER_FAILED', message: error instanceof Error ? error.message.slice(0, 400) : 'Falha ao compartilhar' },
            updatedAt: now(),
          }
          this.repo.transaction(() => this.repo.saveOperation(failed))
          return failed
        }
      }
      case 'team.artifacts.revoke': {
        this.access.team(p.teamId)
        const existing = this.idempotent(p.idempotencyKey, p)
        if (existing) return this.repo.artifact(p.artifactId)
        const { artifact, deliveredTo } = this.artifacts.revoke(p.artifactId)
        this.repo.transaction(() =>
          this.repo.insertOperation(
            this.operation('team.artifact.revoke', { teamId: p.teamId, detail: { artifactId: artifact.id, deliveredCopies: deliveredTo.length } }),
            p.idempotencyKey,
            teamFingerprint(p),
            p
          )
        )
        this.scheduler.event({
          teamId: p.teamId,
          kind: 'artifact.revoked',
          summary: deliveredTo.length
            ? `Acesso revogado; ${deliveredTo.length} cópia(s) já entregue(s) não podem ser apagadas remotamente`
            : 'Acesso ao arquivo revogado',
          detail: { artifactId: artifact.id, deliveredCopies: deliveredTo.length },
        })
        return artifact
      }
      case 'team.artifacts.transferBegin':
        return this.transferBegin(p)
      case 'team.artifacts.transferChunk':
        return this.transferChunk(p)
      case 'team.artifacts.transferFinish':
        return this.transferFinish(p)
      case 'team.artifacts.transferAbort': {
        const transfer = this.repo.transfer(p.transferId)
        if (transfer.direction === 'upload') await this.artifacts.abort(this.repo.artifact(transfer.artifactId))
        this.repo.transaction(() => this.repo.deleteTransfer(p.transferId))
        return { ...transfer, done: false, expiresAt: now() }
      }
      case 'team.operation.get':
        return this.repo.operation(p.operationId)
      case 'team.operation.lookup':
        return this.repo.operationByKey(p.idempotencyKey)?.operation ?? null
    }
  }

  private newMember(teamId: string, input: { botId: string; role: string; coordinator: boolean }, coordinatorBotId: string, grantRevision: number): TeamMember {
    return {
      id: randomUUID(),
      teamId,
      botId: input.botId,
      role: input.role,
      coordinator: input.botId === coordinatorBotId,
      active: true,
      consentedAt: now(),
      grantRevision,
      createdAt: now(),
      updatedAt: now(),
    }
  }

  /** A person's request opens exactly one run; a repeated key returns the same receipt. */
  private send(p: { teamId: string; clientMessageId: string; content: string; artifactIds: string[] }) {
    const team = this.access.team(p.teamId)
    const members = this.repo.members(team.id, true)
    if (members.length < 2) throw new HostError('TEAM_MEMBER_INVALID', 'Esta equipe não tem membros suficientes para trabalhar')
    const coordinator = members.find((member) => member.botId === team.coordinatorBotId)
    if (!coordinator) throw new HostError('TEAM_COORDINATOR_REQUIRED', 'Escolha um bot para coordenar esta equipe')
    const receipt = this.repo.transaction(() => {
      const conversation = this.repo.conversation(team.conversationId)
      const existing = this.repo.messageByClientId(conversation.id, p.clientMessageId)
      if (existing?.runId) {
        if (existing.content !== p.content) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta mensagem já foi enviada com outro conteúdo')
        return { message: existing, run: this.repo.run(existing.runId) }
      }
      if (this.repo.activeRun(conversation.id)) throw new HostError('TEAM_RUN_ACTIVE', 'A equipe ainda está trabalhando no pedido anterior. Aguarde ou pare o trabalho.')
      const resources: TeamArtifactRef[] = p.artifactIds.map((artifactId) => {
        const artifact = this.repo.artifact(artifactId)
        if (artifact.teamId !== team.id || artifact.state !== 'available') throw new HostError('TEAM_GRANT_REVOKED', 'Um dos arquivos escolhidos não está disponível')
        return { artifactId: artifact.id, name: artifact.name, size: artifact.size, digest: artifact.digest, version: artifact.version }
      })
      const runId = randomUUID()
      const sequence = conversation.lastSequence + 1
      const message: TeamMessage = {
        id: randomUUID(),
        conversationId: conversation.id,
        clientMessageId: p.clientMessageId,
        author: { kind: 'human' },
        kind: 'request',
        content: p.content,
        runId,
        sequence,
        artifacts: resources,
        createdAt: now(),
      }
      this.repo.saveMessage(message)
      const grantRevision = coordinator.grantRevision
      const run: TeamRun = {
        id: runId,
        teamId: team.id,
        conversationId: conversation.id,
        messageId: message.id,
        coordinatorBotId: team.coordinatorBotId,
        // The roster is frozen here: changing the team later never rewrites this work.
        roster: members.map((member) => ({
          memberId: member.id,
          botId: member.botId,
          name: this.options.repo.bot(member.botId).name,
          role: member.role,
          coordinator: member.coordinator,
        })),
        resources,
        memberGrantRevision: grantRevision,
        limits: team.policy,
        budget: emptyBudget(),
        round: 0,
        status: 'planning',
        generation: 1,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      }
      this.repo.saveRun(run)
      this.repo.saveConversation({
        ...conversation,
        activeRunId: runId,
        lastSequence: sequence,
        title: conversation.title || p.content.slice(0, 80),
        revision: conversation.revision + 1,
        updatedAt: now(),
      })
      this.repo.saveTask({
        id: randomUUID(),
        runId,
        teamId: team.id,
        round: 0,
        localKey: 'coord-0',
        kind: 'planning',
        assigneeBotId: team.coordinatorBotId,
        memberId: coordinator.id,
        goal: p.content,
        acceptanceCriteria: '',
        dependsOn: [],
        inputArtifactIds: resources.map((resource) => resource.artifactId),
        useDependencyOutputs: true,
        origin: 'human',
        status: 'planned',
        attempts: 0,
        revision: 0,
        createdAt: now(),
        updatedAt: now(),
      })
      return { message, run }
    })
    this.scheduler.event({ teamId: team.id, runId: receipt.run.id, kind: 'run.status', summary: 'A equipe recebeu o pedido', detail: { status: 'planning' } })
    this.scheduler.kick()
    return receipt
  }

  private transferBegin(p: { teamId: string; direction: 'upload' | 'download'; artifactId?: string; name?: string; size?: number; digest?: string }): TeamTransferState {
    this.access.team(p.teamId, p.direction === 'download')
    if (p.direction === 'download') {
      const artifact = this.repo.artifact(p.artifactId ?? '')
      if (artifact.teamId !== p.teamId || artifact.state !== 'available') throw new HostError('TEAM_GRANT_REVOKED', 'Este arquivo não está disponível')
      const transfer: TeamTransferState = {
        transferId: randomUUID(),
        teamId: p.teamId,
        direction: 'download',
        artifactId: artifact.id,
        name: artifact.name,
        size: artifact.size,
        offset: 0,
        chunkBytes: TRANSFER_CHUNK_BYTES,
        digest: artifact.digest,
        done: artifact.size === 0,
        artifact,
        expiresAt: new Date(Date.now() + TRANSFER_TTL_MS).toISOString(),
      }
      this.repo.transaction(() => this.repo.saveTransfer(transfer))
      return transfer
    }
    if (!p.name || p.size === undefined) throw new HostError('INVALID_REQUEST', 'Informe nome e tamanho do arquivo')
    const artifact = this.artifacts.beginUpload(p.teamId, p.name, p.size, p.digest)
    const transfer: TeamTransferState = {
      transferId: randomUUID(),
      teamId: p.teamId,
      direction: 'upload',
      artifactId: artifact.id,
      name: artifact.name,
      size: artifact.size,
      offset: 0,
      chunkBytes: TRANSFER_CHUNK_BYTES,
      ...(p.digest ? { digest: p.digest } : {}),
      done: false,
      artifact,
      expiresAt: new Date(Date.now() + TRANSFER_TTL_MS).toISOString(),
    }
    this.repo.transaction(() => this.repo.saveTransfer(transfer))
    return transfer
  }
  private load(transferId: string) {
    const transfer = this.repo.transfer(transferId)
    if (new Date(transfer.expiresAt).getTime() < Date.now()) {
      this.repo.transaction(() => this.repo.deleteTransfer(transferId))
      throw new HostError('TRANSFER_EXPIRED', 'A transferência expirou; comece novamente')
    }
    return transfer
  }
  private async transferChunk(p: { transferId: string; offset: number; dataBase64?: string }): Promise<TeamTransferState> {
    const transfer = this.load(p.transferId)
    if (p.offset !== transfer.offset) throw new HostError('TRANSFER_OFFSET', `Deslocamento inesperado; retome a partir de ${transfer.offset}`)
    // Resolved by identity: two shared files may legitimately carry the same name.
    const artifact = this.repo.artifact(transfer.artifactId)
    if (transfer.direction === 'download') {
      const bytes = await this.artifacts.read(artifact, p.offset, TRANSFER_CHUNK_BYTES)
      const next: TeamTransferState = { ...transfer, offset: p.offset + bytes.length, dataBase64: bytes.toString('base64'), done: p.offset + bytes.length >= transfer.size, artifact }
      this.repo.transaction(() => this.repo.saveTransfer(next))
      return next
    }
    if (!p.dataBase64) throw new HostError('INVALID_REQUEST', 'Chunk data required for upload')
    const bytes = Buffer.from(p.dataBase64, 'base64')
    if (bytes.length > TRANSFER_CHUNK_BYTES || p.offset + bytes.length > transfer.size) throw new HostError('LIMIT', 'Chunk exceeds declared size')
    await this.artifacts.writeChunk(artifact, p.offset, bytes)
    const next: TeamTransferState = { ...transfer, offset: p.offset + bytes.length, done: p.offset + bytes.length >= transfer.size, artifact }
    this.repo.transaction(() => this.repo.saveTransfer(next))
    return next
  }
  private async transferFinish(p: { transferId: string }): Promise<TeamTransferState> {
    const transfer = this.load(p.transferId)
    if (!transfer.done) throw new HostError('TRANSFER_INCOMPLETE', 'A transferência ainda não terminou')
    let artifact = this.repo.artifact(transfer.artifactId)
    if (transfer.direction === 'upload') {
      // Promotion verifies the whole copy; a mismatch removes the staged bytes and the
      // transfer record, so a failed attempt never leaves a half-shared file behind.
      try {
        artifact = await this.artifacts.promote(artifact)
      } catch (error) {
        this.repo.transaction(() => this.repo.deleteTransfer(p.transferId))
        await this.artifacts.abort(artifact).catch(() => {})
        throw error
      }
      this.scheduler.event({ teamId: transfer.teamId, kind: 'artifact.shared', summary: `Arquivo ${artifact.name} compartilhado com a equipe`, detail: { artifactId: artifact.id, origin: 'human' } })
    }
    this.repo.transaction(() => this.repo.deleteTransfer(p.transferId))
    return { ...transfer, artifact, dataBase64: undefined }
  }
}
export { TEAM_LIMITS }
