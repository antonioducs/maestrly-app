/**
 * MAESTRLY CHAT `review_plan` tool (submit & release). Unlike CLI MCP `review_plan` (which BLOCKS
 * until the user decides), this tool registers the plan in the drawer's "Plan" tab and RETURNS immediately —
 * the runner then cuts the turn at the step boundary (ctx.submitPlan sets the signal). The drawer decision
 * starts a NEW TURN (approve → implement in Agent mode; revise → rework with feedback), which
 * naturally uses the CURRENT model/mode. See stagePlan/decidePlan in plan-broker + plan-ipc.
 */
import { z } from 'zod'
import { defineTool } from './util'

const parameters = z.object({
  plan: z.string().min(1).describe('The implementation plan in Markdown for the user to review.'),
  title: z.string().optional().describe('A short title for the plan.'),
})

export const reviewPlanTool = defineTool<typeof parameters, { staged: boolean; error?: string }>({
  name: 'review_plan',
  description:
    'Submit your implementation plan to the user for review in the "Plan" tab of this app, then STOP — this ' +
    'turn ends immediately (do not keep writing or call other tools after it). The user reviews, edits and ' +
    'approves/discards the plan there; approving starts a NEW turn that implements it. Use this before ' +
    'implementing non-trivial changes to get the plan approved first.',
  parameters,
  execute: async (args, ctx) => {
    if (!ctx.submitPlan) return { staged: false }
    const accepted = ctx.submitPlan(args.plan, args.title)
    return accepted ? { staged: true } : { staged: false, error: 'plan-origin-conflict' }
  },
  toModelText: (_args, result) =>
    result.staged
      ? 'Plan submitted to the user for review. This turn is over — do not continue. The user will decide in the ' +
        'Plan tab; approving it will start a new turn to implement it.'
      : result.error === 'plan-origin-conflict'
        ? 'Plan was not submitted because another plan origin is already awaiting review. Continue this turn without ending it; retry after that review is resolved.'
        : 'Plan review is not available in this context.',
})
