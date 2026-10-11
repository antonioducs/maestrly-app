import { describe, expect, it } from 'vitest'
import type { FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { fleetActivitySegments } from '../../src/renderer/lib/agent-activity'
import {
  searchTranscriptSegments,
  transcriptItemSearchText,
  transcriptSegmentKey,
} from '../../src/renderer/lib/fleet/transcript-search'

const at = '2026-01-01T00:00:00.000Z'
const user = (id: string, text: string): FleetTranscriptItem => ({
  kind: 'user',
  id,
  at,
  text,
  source: 'owner',
  queued: false,
  memories: [],
  images: [],
})
const assistant = (id: string, text: string): FleetTranscriptItem => ({
  kind: 'assistant',
  id,
  at,
  text,
  streaming: false,
})
const reasoning = (id: string, text: string): FleetTranscriptItem => ({
  kind: 'reasoning',
  id,
  at,
  text,
  truncated: false,
  streaming: false,
})
const tool = (id: string, target: string, output: string): FleetTranscriptItem => ({
  kind: 'tool',
  id,
  at,
  name: 'bash',
  target,
  state: 'done',
  output,
  images: [],
})

describe('bot transcript search', () => {
  it('searches only the text the owner reads, ignoring tool targets and output', () => {
    expect(transcriptItemSearchText(user('input:1', 'Deploy staging'))).toBe('Deploy staging')
    expect(transcriptItemSearchText(tool('m1:0', 'deploy.sh', 'deploy ok'))).toBe('')
    expect(
      transcriptItemSearchText({ kind: 'compaction', id: 'c1', at, origin: 'manual', summary: null, truncated: false })
    ).toBe('')
  })

  it('returns the matching rows and folded activities, oldest first and case-insensitively', () => {
    const items = [
      user('input:1', 'Please DEPLOY staging'),
      reasoning('m1:0', 'The deploy needs a build first.'),
      tool('m1:1', 'npm run deploy', 'deploy finished'),
      assistant('m1:2', 'Staging is up.'),
      user('input:2', 'Thanks'),
    ]
    const segments = fleetActivitySegments(items, { working: false })
    expect(searchTranscriptSegments(segments, '  deploy ')).toEqual(['input:1', 'activity:m1'])
    expect(searchTranscriptSegments(segments, 'staging')).toEqual(['input:1', 'm1:2'])
    expect(searchTranscriptSegments(segments, 'finished')).toEqual([])
    expect(searchTranscriptSegments(segments, '   ')).toEqual([])
  })

  it('keeps shared screenshots out of the results and gives them their own keys', () => {
    const shot = { id: 'shot', mediaType: 'image/png' as const, byteSize: 10, name: 'Deploy screen' }
    const items = [
      user('input:1', 'Show me'),
      { ...tool('m1:0', 'deploy.sh', 'deploy ok'), images: [shot] } as FleetTranscriptItem,
      assistant('m1:1', 'Here it is.'),
    ]
    const segments = fleetActivitySegments(items, { working: false })
    const images = segments.find((segment) => segment.kind === 'images')
    if (!images) throw new Error('expected an images segment')
    expect(transcriptSegmentKey(images)).toBe('images:m1:0')
    expect(searchTranscriptSegments(segments, 'deploy')).toEqual([])
    expect(searchTranscriptSegments(segments, 'here')).toEqual(['m1:1'])
  })
})
