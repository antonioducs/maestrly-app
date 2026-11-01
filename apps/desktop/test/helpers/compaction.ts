import { COMPACTION_SUMMARY_SECTIONS } from '../../src/main/chat/compaction/summary-prompt'

/** A summary that passes the structured-compaction audit, carrying `objective` as its distinguishing content. */
export function structuredSummary(objective: string): string {
  return COMPACTION_SUMMARY_SECTIONS.map(
    (section, index) => `## ${section}\n${index === 0 ? objective : '(none)'}`
  ).join('\n\n')
}
