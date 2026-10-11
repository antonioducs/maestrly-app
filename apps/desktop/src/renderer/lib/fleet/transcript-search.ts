import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import type { FleetActivitySegment } from '../agent-activity'

/** The text the owner reads on a transcript row; like chat search, tool I/O and identifiers are not searched. */
export function transcriptItemSearchText(item: FleetTranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'peer_out':
      return item.text
    case 'compaction':
      return item.summary ?? ''
    default:
      return ''
  }
}

export function transcriptSegmentKey(segment: FleetActivitySegment): string {
  if (segment.kind === 'activity') return segment.key
  return segment.kind === 'images' ? `images:${segment.item.id}` : segment.item.id
}

/** The keys of the rendered segments whose readable text contains `query` (case-insensitive), in the order they are shown. */
export function searchTranscriptSegments(segments: readonly FleetActivitySegment[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const matches = (text: string) => text.toLowerCase().includes(needle)
  return segments
    .filter((segment) =>
      segment.kind === 'activity'
        ? segment.steps.some((step) => step.kind !== 'tool' && matches(step.text))
        : matches(transcriptItemSearchText(segment.item))
    )
    .map(transcriptSegmentKey)
}
