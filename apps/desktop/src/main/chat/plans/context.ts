/**
 * What a compaction summary says about the conversation's plans: an index of every plan and the approved one being
 * implemented. The section is rebuilt from the plan store on every compaction, outside the model's summary text, so
 * a long plan never inflates the summary nor reaches the summarizer again.
 */

export type PlanStatus = 'proposed' | 'approved' | 'revised' | 'discarded' | 'superseded'

export interface PlanEntry {
  id: string
  version: number
  title?: string
  content: string
  status: PlanStatus
  createdAt: number
}

/** Above this many estimated tokens, the summary carries the approved plan's outline and `plan_read` the rest. */
export const PLAN_INLINE_MAX_TOKENS = 4_000
const PLAN_INDEX_MAX = 10
const OUTLINE_MAX_CHARS = 4_000
const OUTLINE_LINE_MAX_CHARS = 200

const PLANS_BLOCK = /\n*<conversation_plans>[\s\S]*?<\/conversation_plans>/g
/** The verbatim block summaries carried before plans were stored apart. */
const LEGACY_CARRIED_PLAN =
  /\n*(?:The plan the user approved, kept verbatim across compaction\.[^\n]*\n)?<approved_plan>[\s\S]*?<\/approved_plan>/g

export const planRef = (id: string): string => `plan_${id.replace(/-/g, '').slice(0, 8)}`

const PROPOSED_PLAN_OPEN = '<proposed_plan>'
const PROPOSED_PLAN_CLOSE = '</proposed_plan>'

/**
 * Some models (ChatGPT's) wrap the `review_plan` argument in a `<proposed_plan>` tag, which the Plan tab would show
 * as a raw line. Drops that wrapper, or an opening or closing tag left at the start or end alone; tags in the middle
 * of the plan are content.
 */
export function stripProposedPlanTag(plan: string): string {
  let text = plan.trim()
  if (text.slice(0, PROPOSED_PLAN_OPEN.length).toLowerCase() === PROPOSED_PLAN_OPEN) {
    text = text.slice(PROPOSED_PLAN_OPEN.length).trimStart()
  }
  const tail = text.slice(Math.max(0, text.length - PROPOSED_PLAN_CLOSE.length))
  if (tail.toLowerCase() === PROPOSED_PLAN_CLOSE) text = text.slice(0, text.length - tail.length).trimEnd()
  // A plan that was only the tag keeps its text: staging nothing would hide what the model sent.
  return text || plan.trim()
}

/** Conservative UTF-8 estimate, the same bytes/3 the portable context uses. */
export function estimatePlanTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** A short title for a plan submitted without one: its first heading, or else its first line. */
export function planTitleFrom(content: string): string {
  const lines = content.split('\n').map((line) => line.trim())
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line))
  const first = heading ?? lines.find(Boolean) ?? ''
  return clip(first.replace(/^#{1,6}\s+/, '').trim(), 80)
}

/** Headings and top-level list items, which carry a plan's steps without their detail. */
export function planOutline(content: string): string {
  const lines = content
    .split('\n')
    .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line) || /^ ?(?:[-*+]|\d+[.)])\s+\S/.test(line))
    .map((line) => clip(line.trimEnd(), OUTLINE_LINE_MAX_CHARS))
  const kept: string[] = []
  let length = 0
  for (const line of lines) {
    if (length + line.length + 1 > OUTLINE_MAX_CHARS) {
      kept.push('…')
      break
    }
    kept.push(line)
    length += line.length + 1
  }
  return kept.join('\n')
}

/** The summary without its plans section, nor the verbatim plan older summaries carried. */
export function summaryWithoutPlans(summary: string): string {
  return summary.replace(PLANS_BLOCK, '').replace(LEGACY_CARRIED_PLAN, '').trimEnd()
}

/** The approved plan being implemented: the latest plan, while no newer one was proposed after it. */
export function activePlan(plans: readonly PlanEntry[]): PlanEntry | null {
  const latest = plans.at(-1)
  return latest?.status === 'approved' ? latest : null
}

function indexLine(plan: PlanEntry, active: boolean): string {
  const date = new Date(plan.createdAt).toISOString().slice(0, 10)
  const title = plan.title?.trim() || planTitleFrom(plan.content)
  return `- ${planRef(plan.id)} · v${plan.version} · ${plan.status}${active ? ' (being implemented)' : ''} · ${title} · ${date}`
}

/**
 * The plans section a summary ends with: the index, then the approved plan being implemented. `activeInContext` means
 * the message holding that plan stays verbatim after the summary, so only the index is repeated.
 */
export function plansSection(plans: readonly PlanEntry[], opts: { activeInContext?: boolean } = {}): string {
  if (plans.length === 0) return ''
  const active = activePlan(plans)
  const shown = plans.slice(-PLAN_INDEX_MAX)
  const lines = [
    '<conversation_plans>',
    'Plans from this conversation, oldest first. Read one in full with plan_read and its id.',
    ...(plans.length > shown.length ? [`- … ${plans.length - shown.length} older plans`] : []),
    ...shown.map((plan) => indexLine(plan, plan === active)),
  ]
  if (active) {
    const ref = planRef(active.id)
    const tokens = estimatePlanTokens(active.content)
    lines.push('')
    if (opts.activeInContext) {
      lines.push(`The approved plan ${ref} is being implemented; the message that approved it is still below.`)
    } else if (tokens <= PLAN_INLINE_MAX_TOKENS) {
      lines.push(
        `The plan the user approved (${ref}), kept verbatim across compaction. Keep following it exactly; ignore it ` +
          'only if it is already fully implemented or the user changed course after approving it:',
        `<approved_plan id="${ref}">`,
        active.content.trim(),
        '</approved_plan>'
      )
    } else {
      lines.push(
        `The plan the user approved (${ref}) is too long to repeat here (about ${tokens} tokens). Read it in full ` +
          'with plan_read before continuing its implementation, and keep following it exactly; ignore it only if it ' +
          'is already fully implemented or the user changed course after approving it. Its outline:',
        `<approved_plan_outline id="${ref}">`,
        planOutline(active.content) || clip(active.content.trim(), OUTLINE_MAX_CHARS),
        '</approved_plan_outline>'
      )
    }
  }
  lines.push('</conversation_plans>')
  return lines.join('\n')
}

/** `summary` ending with a fresh plans section in place of any older one. */
export function summaryWithPlans(
  summary: string,
  plans: readonly PlanEntry[],
  opts: { activeInContext?: boolean } = {}
): string {
  const base = summaryWithoutPlans(summary)
  const section = plansSection(plans, opts)
  return section ? `${base}\n\n${section}` : base
}
