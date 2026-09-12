import type { PlanDecisionResponse } from '../../preload'

export function planDecisionError(result: PlanDecisionResponse | void): string | null {
  if (!result || result.ok) return null
  return result.error || 'plan-decision-failed'
}
