import type {
  ConversationDispatchSettings,
  ConversationDispatchSettingsRequest,
} from '../../shared/conversation-dispatch'
import type { MaestroResourceMode, MaestroResourceV1 } from '../../shared/maestro'
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'
import type { ResolvedConversationDispatchSettings } from '../conversation-dispatch-settings'

export const MAESTRO_WORKER_FOOTER: string = [
  '# Delivery contract (from Maestro)',
  '- You work in your own worktree and branch. Do not switch branches. Commit your work before reporting.',
  '- Before reporting, run the build, typecheck/lint and the affected tests (or add tests that cover the task) and report each result. Do not report success for a check you did not run.',
  '- For UI work, start the dev server in a drawer terminal (terminal_create/terminal_run), open it in the embedded browser, verify it against the reference you were given, and say what you checked.',
  '- If you are asked to integrate the feature branch after a merge conflict, merge it into your branch, resolve the conflict, re-run the checks above and report again.',
  '- Your final answer is the report: what changed, the branch, the last commit SHA, the validation results, and open points.',
].join('\n')

export function composeMaestroWorkerPrompt(input: { instructions?: string; task: string }): string {
  const sections: string[] = []
  const instructions = input.instructions?.trim()
  if (instructions) {
    sections.push(`# Role\n${instructions}`)
  }
  sections.push(`# Task\n${input.task.trim()}`)
  sections.push(MAESTRO_WORKER_FOOTER)
  return sections.join('\n\n')
}

export type MaestroDispatchAgentError = 'unknown-agent' | 'agent-unavailable' | 'mode-unavailable'

export async function resolveMaestroDispatchAgent(args: {
  pool: MaestroResourceV1[]
  agentId: string
  supportedModes: readonly MaestroResourceMode[]
  resolve: (requested: ConversationDispatchSettingsRequest) => Promise<ResolvedConversationDispatchSettings>
}): Promise<
  | { ok: true; resource: MaestroResourceV1; settings: ConversationDispatchSettings; mode: MaestroResourceMode }
  | { ok: false; error: MaestroDispatchAgentError; message: string }
> {
  const enabled = args.pool.filter((resource) => resource.enabled)
  const targetKey = normalizeSubagentProfileKey(args.agentId)
  const resource =
    targetKey.length > 0 ? enabled.find((item) => normalizeSubagentProfileKey(item.id) === targetKey) : undefined
  if (!resource) {
    const enabledIds = enabled.map((item) => item.id).join(', ') || 'none'
    return {
      ok: false,
      error: 'unknown-agent',
      message: `Unknown Agent Pool resource "${args.agentId}". Enabled resources: ${enabledIds}.`,
    }
  }

  if (!args.supportedModes.includes(resource.mode)) {
    return {
      ok: false,
      error: 'mode-unavailable',
      message: `Resource "${resource.id}" runs in ${resource.mode} mode, which conversations cannot start in yet.`,
    }
  }

  if (resource.candidates.length === 0) {
    const resolved = await args.resolve({ mode: resource.mode })
    if (resolved.ok) {
      return { ok: true, resource, settings: resolved.settings, mode: resource.mode }
    }
    return {
      ok: false,
      error: 'agent-unavailable',
      message: `No model of resource "${resource.id}" is available:\n${resolved.message}`,
    }
  }

  const failures: string[] = []
  for (const candidate of resource.candidates) {
    const resolved = await args.resolve({
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      reasoning: candidate.effort,
      fastMode: candidate.fastMode ?? false,
      mode: resource.mode,
    })
    if (resolved.ok) {
      return { ok: true, resource, settings: resolved.settings, mode: resource.mode }
    }
    failures.push(`${candidate.providerId}/${candidate.modelId}: ${resolved.message}`)
  }

  return {
    ok: false,
    error: 'agent-unavailable',
    message: [`No model of resource "${resource.id}" is available:`, ...failures].join('\n'),
  }
}
