import {
  COLLABORATION_METHODS,
  TEAM_LIMITS,
  type Bot,
  type CollaborationMethod,
  type Team,
  type TeamArtifact,
  type TeamArtifactGrant,
  type TeamMemory,
  type TeamRun,
  type TeamTask,
  type TeamTurnContext,
} from '@maestrly/host-protocol'

export type TeamStage = TeamTurnContext['stage']
/** The stage a task runs in; it decides which collaboration tools exist for that turn. */
export const stageOf = (task: TeamTask): TeamStage =>
  task.kind === 'planning' ? 'planning' : task.kind === 'consolidation' ? 'consolidation' : 'working'

/**
 * Only the coordinator may delegate, and only while planning. A worker can look at the
 * roster of its own run, publish what it produced and propose a memory to the person; it
 * can never create children, change the team, approve a human request or delegate back.
 */
export function toolsFor(role: 'coordinator' | 'member', stage: TeamStage): CollaborationMethod[] {
  const shared: CollaborationMethod[] = ['team_members', 'team_publish_file', 'team_memory_propose', 'team_operation']
  if (role !== 'coordinator') return shared
  return stage === 'planning' ? ['team_delegate', 'team_status', ...shared] : ['team_status', ...shared]
}

export function remainingOf(run: TeamRun) {
  return {
    rounds: Math.max(0, run.limits.maxRounds - run.budget.rounds),
    tasks: Math.max(0, run.limits.maxTasks - run.budget.tasks),
    turns: Math.max(0, run.limits.maxTurns - run.budget.turns),
    toolCalls: Math.max(0, run.limits.maxToolCalls - run.budget.toolCallsReserved),
    activeMs: Math.max(0, run.limits.maxActiveMs - run.budget.activeMsReserved),
  }
}

/**
 * The permission mode actually applied to a team turn: the intersection of what the team
 * was authorized to do and what the bot itself is allowed to do. A team never widens a
 * member's permissions, and `full-vm` still never means administrative access to the Host.
 */
export function effectivePermissionMode(team: Pick<Team, 'policy'>, bot: Pick<Bot, 'permissionMode'>): Bot['permissionMode'] {
  return team.policy.permissionMode === 'full-vm' && bot.permissionMode === 'full-vm' ? 'full-vm' : 'ask'
}

export interface TeamContextInput {
  team: Team
  run: TeamRun
  task: TeamTask
  bots: Map<string, Bot>
  memories: TeamMemory[]
  grants: { grant: TeamArtifactGrant; artifact: TeamArtifact }[]
  dependencies: TeamTask[]
}
/**
 * Everything the guest learns about the team for one turn. It carries the objective, the
 * consented roles, the approved team memory, the verified copies already delivered into
 * this bot's own workspace and the results this task depends on — and nothing else. No
 * private conversation, no private memory, no Host path, no account and no other bot's
 * workspace ever appears here.
 */
export function buildTeamContext(input: TeamContextInput): TeamTurnContext {
  const { team, run, task } = input
  const role = task.assigneeBotId === run.coordinatorBotId && task.kind !== 'work' ? 'coordinator' : 'member'
  const stage = stageOf(task)
  return {
    teamId: team.id,
    teamName: team.name,
    runId: run.id,
    taskId: task.id,
    round: task.round,
    stage,
    role,
    objective: team.objective,
    members: run.roster.map((entry) => ({
      botId: entry.botId,
      name: entry.name,
      role: entry.role,
      coordinator: entry.coordinator,
      // Only a worker slot is assignable, and only the coordinator ever sees this as useful.
      assignable: !entry.coordinator && role === 'coordinator' && stage === 'planning',
    })),
    memory: input.memories.filter((memory) => memory.status === 'active').slice(0, 64).map((memory) => ({ id: memory.id, content: memory.content })),
    resources: input.grants
      .filter(({ grant }) => grant.state === 'delivered')
      .slice(0, 16)
      .map(({ grant, artifact }) => ({
        artifactId: artifact.id,
        name: artifact.name,
        path: grant.path,
        digest: artifact.digest,
        size: artifact.size,
        origin: artifact.origin.kind === 'human' ? 'compartilhado pela pessoa' : `produzido por ${input.bots.get(artifact.origin.botId)?.name ?? 'outro membro'}`,
      })),
    dependencyResults: task.useDependencyOutputs
      ? input.dependencies.slice(0, TEAM_LIMITS.maxTasks).map((dependency) => ({
          taskId: dependency.id,
          localKey: dependency.localKey,
          botName: input.bots.get(dependency.assigneeBotId)?.name ?? 'membro',
          status: dependency.status,
          summary: dependency.result?.summary.slice(0, 16 * 1024) ?? '',
        }))
      : [],
    remaining: remainingOf(run),
    tools: toolsFor(role, stage).filter((tool) => COLLABORATION_METHODS.includes(tool)),
  }
}

/** Role instructions for one turn. They never replace or rewrite the bot's own persona. */
export function teamInstructions(input: { bot: Bot; team: Team; task: TeamTask; role: 'coordinator' | 'member'; stage: TeamStage }): string {
  const base = input.bot.instructions.trim() || `Você é ${input.bot.name}, um bot que trabalha dentro de um computador Linux próprio.`
  const lines = [
    base,
    '',
    `Você está trabalhando na equipe "${input.team.name}".`,
    input.team.objective ? `Objetivo da equipe: ${input.team.objective}` : '',
  ]
  if (input.role === 'coordinator' && input.stage === 'planning')
    lines.push(
      'Você coordena este trabalho. Se precisar de outros membros, envie UM lote de tarefas com team_delegate e depois encerre seu turno: o Host inicia os membros e chama você de volta com os resultados.',
      'Se conseguir responder sozinho, responda direto sem delegar. Você não aprova pedidos feitos à pessoa e não executa a tarefa de outro membro.'
    )
  else if (input.role === 'coordinator')
    lines.push(
      'Este é o fechamento do trabalho. Consolide os resultados recebidos, diga com clareza o que foi concluído, o que falhou e o que ainda depende de uma decisão da pessoa. Não invente resultados que não estão na lista.'
    )
  else
    lines.push(
      'Você recebeu uma tarefa da equipe. Trabalhe somente no seu espaço de trabalho, entregue o resultado no texto final e publique arquivos com team_publish_file quando produzir algo que a equipe precise usar.',
      'Você não pode delegar, alterar a equipe nem responder no lugar da pessoa.'
    )
  lines.push('', `Tarefa: ${input.task.goal}`)
  if (input.task.acceptanceCriteria) lines.push(`Critérios de conclusão: ${input.task.acceptanceCriteria}`)
  return lines.filter(Boolean).join('\n')
}
