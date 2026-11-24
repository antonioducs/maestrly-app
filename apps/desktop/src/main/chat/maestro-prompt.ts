import type { MaestroResourceV1, MaestroStrategy, MaestroTurnSnapshotV1 } from '../../shared/maestro'

export function maestroStrategyGuidance(strategy: MaestroStrategy): string {
  switch (strategy) {
    case 'best-quality':
      return 'Prefer the strongest suitable resources. Review every delivered task in depth before merging; send important findings back to the author and review again.'
    case 'fast':
      return 'Favor fast suitable resources and dispatch every independent task at once. Keep the review of each delivery; never skip the quality gate.'
    case 'economy':
      return 'Prefer economical resources. Escalate to a stronger resource only after a failure, a hard uncertainty or an important finding, and say so.'
    case 'balanced':
      return 'Balance quality, speed and cost: lighter resources for closed-contract tasks, stronger ones for uncertain or cross-cutting work; review depth follows risk.'
  }
}

function formatResourceModels(resource: MaestroResourceV1): string {
  if (!resource.candidates.length) return 'inherits the orchestrator'
  return resource.candidates
    .map(
      (candidate) =>
        `${candidate.providerId}/${candidate.modelId} effort=${candidate.effort} Fast=${candidate.fastMode === true ? 'on' : 'off'}`
    )
    .join(' | ')
}

function formatResourceInstructions(instructions: string | undefined): string {
  const collapsed = instructions?.replace(/\s+/g, ' ').trim() ?? ''
  if (!collapsed) return '(none)'
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed
}

export function renderMaestroPoolCatalog(turn: MaestroTurnSnapshotV1): string {
  const enabled = turn.pool.filter((resource) => resource.enabled)
  const blocks = enabled.map((resource) =>
    [
      `- ${resource.id} (${resource.label})`,
      `  mode: ${resource.mode}`,
      `  description: ${resource.description}`,
      `  specialties: ${resource.specialties.join(', ') || 'general'}`,
      `  models: ${formatResourceModels(resource)}`,
      `  instructions: ${formatResourceInstructions(resource.instructions)}`,
    ].join('\n')
  )
  return [
    '# Maestro Agent Pool',
    'Each task in `start_conversations` names one of these enabled resource ids in `agent`.',
    ...blocks,
  ].join('\n')
}

export const MAESTRO_SWARM_CONTRACT = `# Maestro swarm contract
You orchestrate a swarm of conversations. Each task runs in its own conversation, worktree and branch, started from your current HEAD, which is the feature branch. You plan, dispatch, review, merge and deliver.
If your branch is the workspace's default branch, create a feature branch (git switch -c feat/<slug>) before dispatching.
1. Plan: split the work into tasks with closed contracts (exact files, types and interfaces, acceptance criteria). Declare them with swarm_update, with dependsOn.
2. Choose one Agent Pool resource per task from the catalog below (mode, description, specialties, instructions). #name in the person's message is a mandatory selection for that responsibility.
3. Dispatch every task whose dependencies are merged in one start_conversations call: agent=<resource id>, requestKey=<task key>, a self-contained prompt. Workers do not see this conversation; the host adds their delivery contract.
4. Each worker's final report arrives as a new turn. Mark the task reviewing, then review its diff (git diff HEAD...<branch>) against the plan, typing, edge cases and the reported validation. Send required changes to the SAME conversation with send_to_conversation (reportBack: true) and mark it changes (reason review).
5. Approved: git merge --no-ff <branch> here. On conflict: git merge --abort, mark it changes (reason conflict), and ask the author to merge the current feature branch into theirs, resolve, re-run the checks and report again.
6. Dispatch the tasks that became unblocked.
7. When every task is merged: run the build and the tests on the feature branch, fix or re-dispatch failures, then report per task which resource did it, the review rounds and open points. Push and open one pull request only when the approved plan or the person asks for it; repository instructions prevail.
The host tracks implementing, delivered, failed and merged phases and shows you the swarm state at the start of each turn. Do not poll other conversations; results come to you. Only finish a turn waiting for results when every dispatched task is running or delivered.`

export function renderMaestroSwarmSection(turn: MaestroTurnSnapshotV1): string {
  return `${MAESTRO_SWARM_CONTRACT}\n\n${renderMaestroPoolCatalog(turn)}\n\n# Frozen Maestro Strategy\nStrategy: ${turn.strategy}\n${maestroStrategyGuidance(turn.strategy)}`
}
