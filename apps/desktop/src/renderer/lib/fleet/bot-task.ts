import {
  FLEET_TASK_COMPLEXITY_TIER,
  type FleetTaskComplexity,
  type FleetTranscriptTask,
} from '@maestrly/bot-fleet-protocol'

/** A task row's second line: how hard the bot said it is (when the bot delegates) and the model that runs it. */
export function taskSummary(task: FleetTranscriptTask): {
  complexity: FleetTaskComplexity | null
  model: string | null
} {
  return { complexity: task.delegation?.complexity ?? null, model: task.model }
}

/** Why a task ran where it did, as `transcript.task.why.<key>` sentences with their values. */
export function taskReasons(task: FleetTranscriptTask): Array<{ key: string; values: Record<string, string> }> {
  const model = task.model ?? ''
  const delegation = task.delegation
  if (!delegation) return [{ key: 'conversationModel', values: { model } }]
  const reasons: Array<{ key: string; values: Record<string, string> }> = [
    delegation.declared
      ? { key: 'declared', values: { complexity: delegation.complexity } }
      : { key: 'default', values: {} },
  ]
  if (!delegation.tier) reasons.push({ key: 'none', values: { model } })
  else if (delegation.upgraded)
    reasons.push({
      key: 'upgraded',
      values: { wanted: FLEET_TASK_COMPLEXITY_TIER[delegation.complexity], tier: delegation.tier, model },
    })
  else reasons.push({ key: 'routed', values: { tier: delegation.tier, model } })
  return reasons
}
