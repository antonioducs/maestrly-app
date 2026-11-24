export type MaestroSwarmPhase =
  | 'queued'
  | 'implementing'
  | 'delivered'
  | 'reviewing'
  | 'changes'
  | 'merged'
  | 'blocked'
  | 'failed'

export type MaestroSwarmChangesReason = 'review' | 'conflict'

export const MAESTRO_SWARM_HOST_PHASES: readonly MaestroSwarmPhase[] = ['implementing', 'delivered', 'merged', 'failed']

export interface MaestroSwarmTask {
  orchestratorConversationId: string
  key: string
  title: string
  resourceId: string | null
  dependsOn: string[]
  conversationId: string | null
  branch: string | null
  /** Commit the worker branch started from; a branch still at it has nothing to merge. */
  baseCommit: string | null
  phase: MaestroSwarmPhase
  changesReason: MaestroSwarmChangesReason | null
  reviewRound: number
  note: string | null
  mergedCommit: string | null
  createdAt: number
  updatedAt: number
}

export interface MaestroSwarmTaskUpdate {
  key: string
  title?: string
  agent?: string
  dependsOn?: string[]
  phase?: 'queued' | 'reviewing' | 'changes' | 'blocked'
  reason?: MaestroSwarmChangesReason
  note?: string
}

function escapeCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const cleaned = value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim()
  return cleaned.length > 0 ? cleaned : '-'
}

function formatPhase(task: MaestroSwarmTask): string {
  if (task.phase === 'changes' && task.changesReason) {
    return `changes (${task.changesReason})`
  }
  return task.phase
}

export function renderMaestroSwarmState(tasks: MaestroSwarmTask[]): string {
  if (tasks.length === 0) return ''
  const ordered = [...tasks].sort((a, b) => a.createdAt - b.createdAt)
  const rows = ordered.map((task) => {
    const cells = [
      escapeCell(task.key),
      escapeCell(task.title),
      escapeCell(task.resourceId),
      escapeCell(task.conversationId),
      escapeCell(task.branch),
      escapeCell(formatPhase(task)),
      String(task.reviewRound),
      escapeCell(task.note),
    ]
    return `| ${cells.join(' | ')} |`
  })
  return [
    '# Maestro swarm state',
    '',
    '| key | title | agent | conversation | branch | phase | round | note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Host-owned phases: implementing, delivered, merged, failed. Update the others with swarm_update.',
  ].join('\n')
}
