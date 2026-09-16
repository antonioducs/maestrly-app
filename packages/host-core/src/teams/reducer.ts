import {
  TEAM_TASK_TERMINAL,
  type BotTurn,
  type DelegatedTask,
  type TeamRun,
  type TeamTask,
  type TeamTaskStatus,
} from '@maestrly/host-protocol'
import { HostError } from '../errors.js'

/**
 * Pure decisions of the teams domain. Everything here is a function of durable records:
 * what a turn actually ended as, which dependencies actually succeeded and which tasks
 * actually produced a result. The coordinator's prose never redefines any of it.
 */

/** How a physical turn ending maps onto the logical task. */
export function taskStatusForTurn(turn: BotTurn): { status: TeamTaskStatus; error?: { code: string; message: string } } {
  switch (turn.status) {
    case 'succeeded':
      return { status: 'succeeded' }
    case 'cancelled':
      return { status: 'cancelled' }
    case 'interrupted':
      // A takeover pauses the task; the person decides whether it continues.
      return turn.error?.code === 'HUMAN_TAKEOVER'
        ? { status: 'paused_human' }
        : { status: 'failed', error: turn.error ?? { code: 'INTERRUPTED', message: 'A execução foi interrompida' } }
    default:
      return { status: 'failed', error: turn.error ?? { code: 'TURN_FAILED', message: 'A execução falhou' } }
  }
}

/** A task may start only when every dependency finished successfully. */
export function dependencyState(task: TeamTask, byId: Map<string, TeamTask>): 'ready' | 'waiting' | 'blocked' {
  let ready = true
  for (const id of task.dependsOn) {
    const dependency = byId.get(id)
    if (!dependency) return 'blocked'
    if (dependency.status === 'succeeded') continue
    if (TEAM_TASK_TERMINAL.has(dependency.status)) return 'blocked'
    ready = false
  }
  return ready ? 'ready' : 'waiting'
}

/**
 * Validates a whole delegation batch before anything starts: known assignees, unique keys,
 * no self-delegation, no reference outside the batch and no cycle. A batch is accepted
 * atomically or not at all, so a bad plan never leaves half a round running.
 */
export function validateBatch(input: {
  tasks: readonly DelegatedTask[]
  coordinatorBotId: string
  assignable: ReadonlySet<string>
  availableTasks: number
  knownArtifacts: ReadonlySet<string>
}): DelegatedTask[] {
  const { tasks } = input
  if (!tasks.length) throw new HostError('TEAM_DELEGATION_INVALID', 'Envie ao menos uma tarefa no lote')
  if (tasks.length > input.availableTasks)
    throw new HostError('TEAM_TASK_LIMIT', `Este trabalho ainda permite ${input.availableTasks} tarefa(s); reduza o lote.`)
  const keys = new Set<string>()
  for (const task of tasks) {
    if (keys.has(task.localKey)) throw new HostError('TEAM_DELEGATION_INVALID', `A chave "${task.localKey}" aparece duas vezes no lote`)
    keys.add(task.localKey)
    if (task.assigneeBotId === input.coordinatorBotId)
      throw new HostError('TEAM_DELEGATION_INVALID', 'O coordenador não pode delegar uma tarefa para si mesmo')
    if (!input.assignable.has(task.assigneeBotId))
      throw new HostError('TEAM_MEMBER_INVALID', 'Uma das tarefas foi endereçada a um bot que não participa deste trabalho')
    for (const artifactId of task.inputArtifactIds)
      if (!input.knownArtifacts.has(artifactId))
        throw new HostError('TEAM_GRANT_REVOKED', 'Uma das tarefas pede um arquivo que a equipe não tem autorizado')
  }
  for (const task of tasks)
    for (const dependency of task.dependsOn) {
      if (!keys.has(dependency)) throw new HostError('TEAM_DEPENDENCY_INVALID', `A tarefa "${task.localKey}" depende de "${dependency}", que não está neste lote`)
      if (dependency === task.localKey) throw new HostError('TEAM_DEPENDENCY_INVALID', `A tarefa "${task.localKey}" não pode depender de si mesma`)
    }
  // Topological check: a cycle is rejected before any node is created.
  const pending = new Map(tasks.map((task) => [task.localKey, new Set(task.dependsOn)]))
  const ordered: DelegatedTask[] = []
  while (pending.size) {
    const next = [...pending.entries()].find(([, dependencies]) => dependencies.size === 0)
    if (!next) throw new HostError('TEAM_DEPENDENCY_INVALID', 'As dependências do lote formam um ciclo; nenhuma tarefa foi iniciada')
    pending.delete(next[0])
    for (const dependencies of pending.values()) dependencies.delete(next[0])
    ordered.push(tasks.find((task) => task.localKey === next[0])!)
  }
  return ordered
}

/**
 * The honest outcome of a run. Partial delivery is never promoted to success because the
 * coordinator wrote that it finished, and a run with no useful answer is a failure.
 */
export function runOutcome(tasks: readonly TeamTask[], hasAnswer: boolean): TeamRun['status'] {
  const work = tasks.filter((task) => task.kind === 'work')
  const unfinished = work.filter((task) => task.status !== 'succeeded')
  if (!hasAnswer) return 'failed'
  if (!work.length) return 'succeeded'
  if (!unfinished.length) return 'succeeded'
  return work.some((task) => task.status === 'succeeded') || hasAnswer ? 'partial' : 'failed'
}

/** A short, factual progress line; not a dashboard and not the model's own wording. */
export function progressLine(tasks: readonly TeamTask[], names: Map<string, string>): string {
  const active = tasks.filter((task) => task.status === 'running' || task.status === 'staging' || task.status === 'waiting_bot')
  if (!active.length) return ''
  return active
    .slice(0, 3)
    .map((task) => `${names.get(task.assigneeBotId) ?? 'Membro'} está ${task.kind === 'work' ? 'trabalhando' : 'organizando o trabalho'}`)
    .join(' · ')
}
