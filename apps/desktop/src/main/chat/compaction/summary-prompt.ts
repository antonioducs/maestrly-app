/**
 * Structured portable-compaction prompt and its deterministic audit. Headings stay in English so the audit works in
 * any conversation language; the content under them follows the conversation's language.
 */

export const COMPACTION_SUMMARY_SECTIONS = [
  'Objective',
  'Requirements and constraints',
  'Decisions',
  'Work state',
  'Pending user requests',
  'Next steps',
  'Relevant files',
  'Exact identifiers',
  'Errors and fixes',
] as const

const SECTION_GUIDE: Record<(typeof COMPACTION_SUMMARY_SECTIONS)[number], string> = {
  Objective: "the user's goal, in one or two sentences",
  'Requirements and constraints': 'explicit requirements, preferences, scope limits and rules set by the user',
  Decisions: 'approaches chosen or rejected, each with its reason',
  'Work state':
    'Done, In progress and Blocked items; report every check with the result it actually had, never as passing if it was not run or failed',
  'Pending user requests': "requests not satisfied yet, in the user's own wording",
  'Next steps': 'the next actions, in order',
  'Relevant files': 'paths that matter for the remaining work, each with why',
  'Exact identifiers':
    'ids, paths, commands, URLs, branch names, versions, ports and hashes the work depends on, copied literally',
  'Errors and fixes': 'errors met, with their exact messages, and how each was fixed or why it remains',
}

export const COMPACTION_SYSTEM_PROMPT = [
  'You summarize an agent conversation so the work can continue after older messages leave the model context.',
  'Write in the language of the conversation, using exactly these Markdown headings, in this order, each on its own',
  'line, kept in English even when the conversation uses another language:',
  '',
  ...COMPACTION_SUMMARY_SECTIONS.map((section) => `## ${section}`),
  '',
  'Write (none) under a heading with nothing to record. What each section holds:',
  ...COMPACTION_SUMMARY_SECTIONS.map((section) => `- ${section}: ${SECTION_GUIDE[section]}.`),
  '',
  'Use short bullets. Copy identifiers, paths, commands, URLs and error messages literally. Never invent facts, files,',
  'commands, edits or passing checks. Do not answer or continue the last message and do not call tools: only summarize.',
  '',
  'When the input starts with "Previous summary:", update that summary with the newer messages instead of rewriting it:',
  'keep what still applies, move finished work to Done, drop resolved requests and blockers, and let newer information',
  'win over older. When the input is a set of summaries, merge them section by section into one summary with the same',
  'headings, without dropping unique facts.',
].join('\n')

/** Soft target for the final summary: 20% of the summarized source, between 2k and min(10k, 5% of the window). */
export function compactionSummaryTargetTokens(sourceTokens: number, contextWindow?: number): number {
  const ceiling = Math.max(1, Math.min(10_000, contextWindow ? Math.floor(contextWindow * 0.05) : 10_000))
  const floor = Math.min(2_000, ceiling)
  return Math.max(floor, Math.min(ceiling, Math.ceil(Math.max(0, sourceTokens) * 0.2)))
}

export function compactionTargetInstruction(targetTokens: number): string {
  return (
    `Aim for about ${targetTokens} tokens in the summary. Pending requests, exact identifiers and errors take ` +
    'priority over brevity.'
  )
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*:?\s*#*\s*$/

/**
 * Deterministic, model-free check of the structure the prompt requires: one issue per problem, so attempts can be
 * ranked by how many they have. An empty list means the summary passes.
 */
export function auditCompactionSummary(summary: string): string[] {
  if (!summary.trim()) return ['the summary is empty']
  const headings = new Set<string>()
  for (const line of summary.split('\n')) {
    const match = HEADING.exec(line)
    if (match) headings.add(match[1].replace(/\*+/g, '').trim().toLowerCase())
  }
  return COMPACTION_SUMMARY_SECTIONS.filter((section) => !headings.has(section.toLowerCase())).map(
    (section) => `missing section "## ${section}"`
  )
}
