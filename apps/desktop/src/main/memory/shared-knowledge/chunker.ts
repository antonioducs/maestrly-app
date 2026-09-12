import type { SharedKnowledgeDocument } from '../../../shared/memory'

export interface SharedKnowledgeChunk {
  id: string
  documentId: string
  heading?: string
  content: string
  startLine: number
  endLine: number
  ordinal: number
}

const MAX_CHARS = 4_000

export function chunkSharedKnowledge(document: SharedKnowledgeDocument): SharedKnowledgeChunk[] {
  const lines = document.content.replaceAll('\r\n', '\n').split('\n')
  // Parser provenance points at the first heading when one exists. Chunks, however, include any preamble
  // before it, so recover the actual first body line to keep every chunk range source-accurate.
  const firstHeadingLine = document.provenance.heading
    ? lines.findIndex((line) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim() === document.provenance.heading)
    : -1
  const baseLine = Math.max(1, (document.provenance.startLine ?? 1) - Math.max(0, firstHeadingLine))
  const sections: Array<{ heading?: string; start: number; end: number }> = []
  let current = 0
  let heading: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index])
    if (!match) continue
    if (index > current) sections.push({ heading, start: current, end: index })
    current = index
    heading = match[1]?.trim()
  }
  if (current < lines.length) sections.push({ heading, start: current, end: lines.length })
  if (sections.length === 0 && document.content) sections.push({ start: 0, end: lines.length })

  const chunks: SharedKnowledgeChunk[] = []
  for (const section of sections) {
    let cursor = section.start
    while (cursor < section.end) {
      let end = cursor
      let size = 0
      while (end < section.end && (size === 0 || size + lines[end].length + 1 <= MAX_CHARS)) {
        size += lines[end].length + 1
        end += 1
      }
      const ordinal = chunks.length
      chunks.push({
        id: `${document.id}:${ordinal}`,
        documentId: document.id,
        ...(section.heading ? { heading: section.heading } : {}),
        content: lines.slice(cursor, end).join('\n'),
        startLine: baseLine + cursor,
        endLine: baseLine + Math.max(cursor, end - 1),
        ordinal,
      })
      cursor = end
    }
  }
  return chunks
}
