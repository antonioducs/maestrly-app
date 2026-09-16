import { createHash, randomUUID } from 'node:crypto'
import {
  TEAM_LIMITS,
  collaborationParamSchemas,
  collaborationResultSchemas,
  type Bot,
  type CollaborationMethod,
  type CollaborationRequest,
  type TeamOperation,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository } from '../bots/repository.js'
import type { TeamAccess } from './access.js'
import type { TeamArtifacts } from './artifacts.js'
import type { TeamMemories } from './memory.js'
import { remainingOf, toolsFor } from './context.js'
import { type TeamRepository, now } from './repository.js'
import type { TeamScheduler } from './scheduler.js'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (method: string, params: unknown) => createHash('sha256').update(`${method}:${canonical(params)}`).digest('hex')

export interface TeamGuestToolsDeps {
  teams: TeamRepository
  bots: BotRepository
  access: TeamAccess
  scheduler: TeamScheduler
  artifacts: TeamArtifacts
  memories: TeamMemories
}

/**
 * The Host side of the collaboration lane. This is deliberately not the public
 * administrative API: a model can only reach these few methods, the acting bot and its run
 * are taken from the authenticated session and the registered turn, and every call is
 * re-checked against the live run, round, membership, grants, budget and desktop hold.
 *
 * Long work answers with a durable acceptance and a consultable operation. A call never
 * waits for a child to finish, because that would hold the caller's only execution slot.
 */
export class TeamGuestTools {
  private inFlight = new Map<string, number>()
  constructor(private readonly deps: TeamGuestToolsDeps) {}

  /** Tools offered for this exact turn; a name the model happens to know is not enough. */
  private assertAvailable(method: CollaborationMethod, role: 'coordinator' | 'member', stage: 'planning' | 'working' | 'consolidation') {
    if (!toolsFor(role, stage).includes(method))
      throw new HostError('TEAM_STAGE_INVALID', 'Esta ação não está disponível para você nesta etapa do trabalho')
  }

  async handle(botId: string, request: CollaborationRequest): Promise<Record<string, unknown>> {
    const bot = this.deps.bots.bot(botId)
    const recorded = this.deps.teams.receipt(request.turnId, request.id)
    const print = fingerprint(request.method, request.params)
    if (recorded) {
      // Same key with different content is a different action, not a retry.
      if (recorded.fingerprint !== print) throw new HostError('IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada com outro conteúdo')
      return recorded.response
    }
    const pending = this.inFlight.get(botId) ?? 0
    if (pending >= TEAM_LIMITS.requestsInFlightMax) throw new HostError('TEAM_BUSY', 'Aguarde a ação anterior terminar')
    this.inFlight.set(botId, pending + 1)
    try {
      const response = await this.execute(bot, request, print)
      this.deps.teams.transaction(() =>
        this.deps.teams.saveReceipt({ turnId: request.turnId, requestId: request.id, method: request.method, fingerprint: print, response, createdAt: now() })
      )
      return response
    } finally {
      this.inFlight.set(botId, (this.inFlight.get(botId) ?? 1) - 1)
    }
  }

  private async execute(bot: Bot, request: CollaborationRequest, print: string): Promise<Record<string, unknown>> {
    const origin = this.deps.access.origin(request.turnId, bot.id)
    const turn = this.deps.bots.turn(request.turnId)
    if (turn.generation !== request.generation) throw new HostError('TEAM_STAGE_INVALID', 'Esta execução não é mais a atual')
    if (turn.status !== 'running' && turn.status !== 'starting') throw new HostError('TEAM_STAGE_INVALID', 'Esta execução não está ativa')
    this.assertAvailable(request.method, origin.role, origin.stage)
    switch (request.method) {
      case 'team_members': {
        const params = collaborationParamSchemas.team_members.parse(request.params)
        void params
        return collaborationResultSchemas.team_members.parse({
          runId: origin.run.id,
          round: origin.task.round,
          stage: origin.stage,
          role: origin.role,
          // Roles and names only: no account, no computer, no path, no secret.
          members: origin.run.roster.map((entry) => ({
            botId: entry.botId,
            name: entry.name,
            role: entry.role,
            coordinator: entry.coordinator,
            assignable: !entry.coordinator && origin.role === 'coordinator' && origin.stage === 'planning',
          })),
          remaining: remainingOf(origin.run),
        })
      }
      case 'team_delegate': {
        const params = collaborationParamSchemas.team_delegate.parse(request.params)
        const receipt = this.deps.scheduler.submitBatch({ turnId: request.turnId, botId: bot.id, tasks: params.tasks })
        return collaborationResultSchemas.team_delegate.parse({
          ...receipt,
          finishTurn: true,
          guidance: 'O lote foi registrado. Encerre este turno: os membros começam em seguida e você será chamado de volta com os resultados.',
        })
      }
      case 'team_status': {
        const tasks = this.deps.teams.tasks(origin.run.id)
        return collaborationResultSchemas.team_status.parse({
          runId: origin.run.id,
          round: origin.task.round,
          status: origin.run.status,
          tasks: tasks
            .filter((task) => task.kind === 'work')
            .map((task) => ({
              taskId: task.id,
              localKey: task.localKey,
              assigneeBotId: task.assigneeBotId,
              status: task.status,
              ...(task.result?.summary ? { summary: task.result.summary } : {}),
              artifacts: task.result?.artifacts ?? [],
              ...(task.error ? { error: task.error.message.slice(0, 400) } : {}),
            })),
          remaining: remainingOf(origin.run),
        })
      }
      case 'team_publish_file': {
        const params = collaborationParamSchemas.team_publish_file.parse(request.params)
        if (!origin.team.policy.shareArtifacts) throw new HostError('TEAM_GRANT_REVOKED', 'Esta equipe não compartilha arquivos entre os membros')
        const operation: TeamOperation = {
          id: randomUUID(),
          kind: 'team.collaboration',
          teamId: origin.team.id,
          runId: origin.run.id,
          taskId: origin.task.id,
          status: 'running',
          detail: { method: 'team_publish_file', botId: bot.id },
          createdAt: now(),
          updatedAt: now(),
        }
        this.deps.teams.transaction(() => this.deps.teams.insertOperation(operation, `collab:${request.turnId}:${request.id}`, print, { method: request.method }))
        try {
          const artifact = await this.deps.artifacts.publish({
            teamId: origin.team.id,
            bot,
            path: params.path,
            name: params.name ?? params.path,
            origin: { kind: 'bot', botId: bot.id, runId: origin.run.id, taskId: origin.task.id },
            runId: origin.run.id,
            taskId: origin.task.id,
          })
          const ref = { artifactId: artifact.id, name: artifact.name, size: artifact.size, digest: artifact.digest, version: artifact.version }
          this.deps.teams.transaction(() => this.deps.teams.saveOperation({ ...operation, status: 'succeeded', detail: { ...operation.detail, artifact: ref }, updatedAt: now() }))
          this.deps.scheduler.event({
            teamId: origin.team.id,
            runId: origin.run.id,
            taskId: origin.task.id,
            botId: bot.id,
            kind: 'artifact.shared',
            summary: `${bot.name} compartilhou ${artifact.name}`,
            detail: { artifactId: artifact.id, digest: artifact.digest, size: artifact.size },
          })
          return collaborationResultSchemas.team_publish_file.parse({ operationId: operation.id, status: 'succeeded', artifact: ref })
        } catch (error) {
          const message = error instanceof HostError ? error.message : 'Não foi possível compartilhar este arquivo'
          this.deps.teams.transaction(() =>
            this.deps.teams.saveOperation({
              ...operation,
              status: 'failed',
              error: { code: error instanceof HostError ? error.code : 'TRANSFER_FAILED', message: message.slice(0, 400) },
              updatedAt: now(),
            })
          )
          return collaborationResultSchemas.team_publish_file.parse({ operationId: operation.id, status: 'failed', error: message.slice(0, 400) })
        }
      }
      case 'team_memory_propose': {
        const params = collaborationParamSchemas.team_memory_propose.parse(request.params)
        const memory = this.deps.memories.propose(origin.team.id, bot.id, params.content)
        this.deps.scheduler.event({
          teamId: origin.team.id,
          runId: origin.run.id,
          botId: bot.id,
          kind: 'memory.proposed',
          summary: `${bot.name} sugeriu uma anotação para a equipe`,
          detail: { memoryId: memory.id },
        })
        return collaborationResultSchemas.team_memory_propose.parse({
          proposalId: memory.id,
          status: 'proposed',
          guidance: 'A sugestão foi registrada para a pessoa aprovar. Ela não vale como memória da equipe até então.',
        })
      }
      case 'team_operation': {
        const params = collaborationParamSchemas.team_operation.parse(request.params)
        const operation = this.deps.teams.operation(params.operationId)
        if (operation.runId !== origin.run.id) throw new HostError('TEAM_NOT_MEMBER', 'Esta operação pertence a outro trabalho')
        const artifact = operation.detail?.artifact
        return collaborationResultSchemas.team_operation.parse({
          operationId: operation.id,
          status: operation.status === 'succeeded' ? 'succeeded' : operation.status === 'failed' ? 'failed' : 'accepted',
          ...(artifact ? { artifact } : {}),
          ...(operation.error ? { error: operation.error.message.slice(0, 400) } : {}),
        })
      }
    }
  }
}
