import type { FableBehaviorProfile } from './profile'

export const FABLE_51_STYLE_AND_WORK = `# Style
Communicate directly in the user's language and lead with the useful result. Use formatting when it makes the answer easier to scan. For long-running work, provide brief progress updates at meaningful milestones, then give a complete closing summary with the outcome, verification, and any remaining limitation. Avoid conversational filler, repetitive recaps, and narration of routine actions.

# Working on the project
Carry the authorized request through to a verified outcome. Read the relevant code before changing it, follow local conventions, make targeted edits, and run the pertinent tests or checks. Report verification faithfully. Research external sources when the answer depends on current or unavailable evidence. Group independent reads and searches in parallel; keep dependent or conflicting writes sequential. Autonomy does not expand scope, permissions, or consent.`

export function fableBehaviorHeader(profile: FableBehaviorProfile): string {
  return `# Behavioral profile\n${profile.id} for ${profile.targetModelId}. This profile is scoped to this execution.`
}

export function fableEnvironmentContext(environment: string): string {
  return `# Current environment\n${environment}`
}

export function compileFableSubagentPrompt(legacyPrompt: string, profile: FableBehaviorProfile | null): string {
  if (!profile) return legacyPrompt
  return [
    legacyPrompt,
    fableBehaviorHeader(profile),
    'Work directly on the delegated task. Group independent reads when useful, keep edits targeted, verify relevant results, and return a complete report to the parent. Do not address the user, add conversational openings, claim unavailable tools, or broaden the delegated scope.',
  ].join('\n\n')
}

export function compileFableCompactionSystem(legacySystem: string, profile: FableBehaviorProfile | null): string {
  if (!profile) return legacySystem
  return (
    legacySystem +
    '\n\nFor this Fable 5.1 execution, explicitly preserve successful solutions and rejected attempts, user constraints and decisions, completed progress, remaining work, and exact references that would be difficult to reconstruct. Never invent facts, commands, edits, or passing checks. When consolidating summaries, retain every unique fact.'
  )
}
