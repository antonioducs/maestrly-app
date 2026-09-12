import { repositoryEvidence } from './workspace.js'
import { maestroStrategyGuidance } from '@maestrly/protocol'
import type { ExecutionContext, ExecutionHandle, ExecutionOutcome, ExecutorAdapter } from './executor.js'

// These roles mirror the pure resource specialties of the desktop Maestro pool.
const resources: Record<string, { description: string; readOnly: boolean }> = {
  explorer: { description: 'Repository exploration and context gathering.', readOnly: true },
  frontend: { description: 'UI, accessibility and client-side implementation.', readOnly: false },
  backend: { description: 'Services, persistence and APIs.', readOnly: false },
  tester: { description: 'Focused validation, tests, lint, typecheck and build checks.', readOnly: false },
  reviewer: { description: 'Independent review of changes and findings.', readOnly: true },
  generalist: { description: 'General implementation and fixes.', readOnly: false },
}
const presets = {
  balanced: { delegates: 3, reviews: 1, fixes: 1 },
  'best-quality': { delegates: 6, reviews: 2, fixes: 2 },
  fast: { delegates: 3, reviews: 1, fixes: 0 },
  economy: { delegates: 1, reviews: 1, fixes: 0 },
}
function structured<T>(value: string | undefined): T {
  if (!value) throw new Error('Maestro returned no structured result.')
  return JSON.parse(
    value
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, '')
  ) as T
}
export async function startOrchestration(
  adapter: ExecutorAdapter,
  context: ExecutionContext
): Promise<ExecutionHandle> {
  const config = context.envelope.snapshot.automation
  if (!config || (config.mode === 'standard' && !config.subagentsEnabled)) return adapter.start(context)
  let active: ExecutionHandle | undefined,
    cancelled = false
  const settings = presets[config.maestroStrategy]
  const base = context.envelope.snapshot.renderedPrompt ?? context.envelope.snapshot.description
  const reports: string[] = []
  const stages: Record<string, unknown>[] = []
  async function stage(role: string, prompt: string, readOnly = false): Promise<ExecutionOutcome> {
    if (cancelled) return { state: 'cancelled' }
    const id = crypto.randomUUID()
    await context.emit({
      type: 'maestro.stage_started',
      data: { id, role, readOnly, strategy: config!.maestroStrategy },
    })
    active = await adapter.start({
      ...context,
      readOnly,
      stageId: id,
      envelope: { ...context.envelope, snapshot: { ...context.envelope.snapshot, renderedPrompt: prompt } },
    })
    if (cancelled) await active.cancel('Orchestration cancelled.')
    const result = await active.done
    stages.push({ id, role, state: result.state, summary: result.summary, failure: result.failure })
    await context.emit({ type: 'maestro.stage_finished', data: { id, role, state: result.state } })
    return result
  }
  const done = (async (): Promise<ExecutionOutcome> => {
    try {
      const guidance = maestroStrategyGuidance(config.maestroStrategy)
      if (config.subagentsEnabled) {
        const planned = await stage(
          'planner',
          `${base}\n\n${guidance}\nPlan independent, bounded delegated tasks. Available resources: ${JSON.stringify(resources)}.
Return ONLY JSON {"tasks":[{"resource":"backend","task":"precise task"}]}. Maximum ${settings.delegates} tasks. Return an empty tasks array if delegation is unnecessary. Do not modify files.`,
          true
        )
        if (planned.state !== 'succeeded') return planned
        const plan = structured<{ tasks: Array<{ resource: string; task: string }> }>(planned.summary)
        if (
          !Array.isArray(plan.tasks) ||
          plan.tasks.length > settings.delegates ||
          plan.tasks.some(
            (t) => !resources[t.resource] || typeof t.task !== 'string' || !t.task.trim() || t.task.length > 10000
          )
        )
          throw new Error('Maestro returned an invalid delegation plan.')
        // A shared checkout has one writer at a time. Delegates are distinct, audited executions.
        for (const task of plan.tasks) {
          const result = await stage(
            task.resource,
            `${base}\n\nDelegated responsibility: ${task.task}\n${resources[task.resource]!.description}\nReport changes, checks and remaining issues.`,
            resources[task.resource]!.readOnly
          )
          if (result.state !== 'succeeded') return result
          reports.push(task.resource + ': ' + (result.summary ?? '').slice(0, 12000))
        }
      }
      const implementation = await stage(
        config.mode === 'maestro' ? 'generalist' : 'parent',
        `${base}\n\n${guidance}\nDelegated results:\n${reports.join('\n\n')}\nComplete the task, reconcile these results and run relevant validation. Do not launch native subagents; delegation is owned by Maestrly.`
      )
      if (implementation.state !== 'succeeded') return implementation
      if (config.mode === 'maestro') {
        let fixes = 0
        for (let review = 0; review < settings.reviews; review++) {
          let accepted = false
          while (!accepted) {
            const evidence = context.environment.gitBaseCommit ? await repositoryEvidence(context.environment) : []
            const patch = evidence.find((item) => item.kind === 'patch')
            const diff = patch ? Buffer.from(patch.bytes).toString('utf8').slice(0, 60000) : ''
            const reviewed = await stage(
              'reviewer',
              `${base}\n\nIndependently inspect the current changes. Do not modify files. Patch excerpt (inspect relevant files when truncated):
${diff}
 Return ONLY JSON {"approved":true,"feedback":"findings and checks"}. Set approved=false for material unresolved issues.`,
              true
            )
            if (reviewed.state !== 'succeeded') return reviewed
            const verdict = structured<{ approved: boolean; feedback: string }>(reviewed.summary)
            if (typeof verdict.approved !== 'boolean' || typeof verdict.feedback !== 'string')
              throw new Error('Maestro returned an invalid review result.')
            if (verdict.approved) {
              accepted = true
              continue
            }
            if (fixes++ >= settings.fixes)
              return {
                state: 'failed',
                failure: 'Maestro review requires human attention: ' + verdict.feedback.slice(0, 12000),
              }
            const fixed = await stage(
              'fixer',
              `${base}\n\nResolve the independent review findings and verify the correction:\n${verdict.feedback.slice(0, 12000)}`
            )
            if (fixed.state !== 'succeeded') return fixed
          }
        }
      }
      return {
        state: 'succeeded',
        summary: implementation.summary,
        artifacts: [
          {
            kind: 'verification',
            name: 'maestro-stages.json',
            contentType: 'application/json',
            bytes: Buffer.from(JSON.stringify({ strategy: config.maestroStrategy, stages }, null, 2)),
          },
        ],
      }
    } catch (error) {
      return cancelled
        ? { state: 'cancelled' }
        : { state: 'failed', failure: error instanceof Error ? error.message : String(error) }
    }
  })()
  return {
    done,
    cancel: async (reason) => {
      cancelled = true
      await active?.cancel(reason)
      await done
    },
  }
}
