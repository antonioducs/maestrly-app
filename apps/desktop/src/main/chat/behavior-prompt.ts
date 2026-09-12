import { type ClaudeBehaviorProfile, isFableBehaviorProfile } from './behavior-profile'
import {
  FABLE_51_STYLE_AND_WORK,
  compileFableCompactionSystem,
  compileFableSubagentPrompt,
  fableBehaviorHeader,
  fableEnvironmentContext,
} from './fable/prompt'
import { OPUS_5_STYLE_AND_WORK } from './opus/prompt'

export function claudeBehaviorHeader(profile: ClaudeBehaviorProfile): string {
  if (isFableBehaviorProfile(profile)) return fableBehaviorHeader(profile)
  return `# Behavioral profile\n${profile.id} for ${profile.targetModelId}. This profile is scoped to this execution.`
}

export function claudeStyleAndWork(profile: ClaudeBehaviorProfile): string {
  return isFableBehaviorProfile(profile) ? FABLE_51_STYLE_AND_WORK : OPUS_5_STYLE_AND_WORK
}

export function claudeEnvironmentContext(environment: string): string {
  return fableEnvironmentContext(environment)
}

export function compileClaudeSubagentPrompt(legacyPrompt: string, profile: ClaudeBehaviorProfile | null): string {
  if (!profile || isFableBehaviorProfile(profile)) return compileFableSubagentPrompt(legacyPrompt, profile)
  return [
    legacyPrompt,
    claudeBehaviorHeader(profile),
    'Complete the full delegated scope autonomously and return a concise, complete report to the parent with the outcome, actual verification evidence, and remaining limitations. Preserve explicit agent definitions, role and tool restrictions, user instructions, and required project checks, including explicitly requested reviews. Keep artifact length appropriate to the deliverable. Group independent reads when useful and keep edits targeted. Avoid redundant review or check loops after required checks pass unless new changes, failures, or unresolved concerns justify them. Delegate only sizable independent work when allowed by the agent definition, and honor explicit named agents. Do not automatically add extra reviewers. Do not address the user, add conversational openings, claim unavailable tools, or broaden the delegated scope.',
  ].join('\n\n')
}

export function compileClaudeCompactionSystem(legacySystem: string, profile: ClaudeBehaviorProfile | null): string {
  if (!profile || isFableBehaviorProfile(profile)) return compileFableCompactionSystem(legacySystem, profile)
  return (
    legacySystem +
    '\n\nFor this Opus 5 execution, preserve continuity facts: the original objective and full authorized scope, explicit user constraints and decisions, agent definitions and named assignments, mode and frozen Strategy and Pool, successful solutions and rejected attempts, completed progress, remaining work, required checks and their actual evidence, and exact references that would be difficult to reconstruct. Preserve unresolved failures and limitations so work resumes without redundant review or check loops. Never invent facts, commands, edits, or passing checks. When consolidating summaries, retain every unique fact.'
  )
}
