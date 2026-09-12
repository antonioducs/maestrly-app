import { createHash } from 'node:crypto'
import type { MemorySearchHit } from '../../shared/memory'
import { isWorkspaceMemoryEnabled } from './access'
import { markLocalMemoriesUsed } from './local-memory-service'
import {
  reconcileMemoryIndex,
  searchMemoryIndexLexical,
  searchMemoryIndexVector,
  type IndexedMemoryCandidate,
  type MemoryScopeRoot,
} from './index'

const DEFAULT_CANDIDATES = 40
const DEFAULT_TOP = 8
const MAX_CHUNKS_PER_DOCUMENT = 2
const MAX_CONTEXT_CHARS = 16 * 1024
const PINNED_BUDGET_CHARS = 3 * 1024
const RRF_K = 60

export interface RetrieveMemoryOptions {
  workspaceId: string
  query: string
  roots?: MemoryScopeRoot[]
  candidateLimit?: number
  limit?: number
  maxChars?: number
  markUsed?: boolean
  signal?: AbortSignal
}

function candidateKey(candidate: IndexedMemoryCandidate): string {
  return `${candidate.kind}:${candidate.repo ?? ''}:${candidate.id}:${candidate.chunkId}`
}

function documentKey(candidate: IndexedMemoryCandidate): string {
  return `${candidate.kind}:${candidate.repo ?? ''}:${candidate.id}`
}

function authorityBoost(candidate: IndexedMemoryCandidate, query: string): number {
  let boost = 0
  if (candidate.kind === 'shared' && (candidate.type === 'constraint' || candidate.type === 'decision')) boost += 0.025
  if (candidate.kind === 'local' && candidate.pinned) boost += 0.03
  if (candidate.alwaysApply) boost += 0.025
  const lower = query.toLocaleLowerCase()
  if (candidate.tags.some((tag) => lower.includes(tag.toLocaleLowerCase()))) boost += 0.008
  if (candidate.scope && lower.includes(candidate.scope.toLocaleLowerCase())) boost += 0.006
  if (candidate.path && lower.includes(candidate.path.toLocaleLowerCase())) boost += 0.006
  return boost
}

function mergeCandidates(
  lexical: IndexedMemoryCandidate[],
  semantic: IndexedMemoryCandidate[],
  pinned: IndexedMemoryCandidate[],
  query: string
): IndexedMemoryCandidate[] {
  const merged = new Map<string, { candidate: IndexedMemoryCandidate; score: number }>()
  const add = (candidate: IndexedMemoryCandidate, rank: number, sourceWeight: number) => {
    const key = candidateKey(candidate)
    const current = merged.get(key)
    const score = sourceWeight / (RRF_K + rank)
    if (current) current.score += score
    else merged.set(key, { candidate, score })
  }
  lexical.forEach((candidate, index) => add(candidate, index + 1, 1))
  semantic.forEach((candidate, index) => add(candidate, index + 1, 1))
  pinned.forEach((candidate, index) => add(candidate, index + 1, 0.8))
  return [...merged.values()]
    .map(({ candidate, score }) => ({ ...candidate, score: score + authorityBoost(candidate, query) }))
    .sort((left, right) => {
      const byScore = right.score - left.score
      if (byScore !== 0) return byScore
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    })
}

function boundResults(candidates: IndexedMemoryCandidate[], limit: number, maxChars: number): MemorySearchHit[] {
  const results: MemorySearchHit[] = []
  const chunksPerDocument = new Map<string, number>()
  const contents = new Set<string>()
  let normalChars = 0
  let pinnedChars = 0
  for (const candidate of candidates) {
    if (results.length >= limit) break
    const doc = documentKey(candidate)
    if ((chunksPerDocument.get(doc) ?? 0) >= MAX_CHUNKS_PER_DOCUMENT) continue
    const normalizedContent = candidate.content.trim()
    if (!normalizedContent) continue
    const contentHash = createHash('sha256').update(normalizedContent).digest('hex')
    if (contents.has(contentHash)) continue
    const isPinned = candidate.pinned || candidate.alwaysApply
    if (isPinned) {
      if (pinnedChars + normalizedContent.length > PINNED_BUDGET_CHARS) continue
      pinnedChars += normalizedContent.length
    } else {
      if (normalChars + pinnedChars + normalizedContent.length > maxChars) continue
      normalChars += normalizedContent.length
    }
    chunksPerDocument.set(doc, (chunksPerDocument.get(doc) ?? 0) + 1)
    contents.add(contentHash)
    const { chunkId: _chunkId, rowid: _rowid, rank: _rank, ...hit } = candidate
    results.push({ ...hit, content: normalizedContent })
  }
  return results
}

export async function retrieveHybridMemory(options: RetrieveMemoryOptions): Promise<MemorySearchHit[]> {
  if (!isWorkspaceMemoryEnabled(options.workspaceId) || !options.query.trim()) return []
  const candidateLimit = Math.max(1, Math.min(options.candidateLimit ?? DEFAULT_CANDIDATES, 100))
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_TOP, 10))
  await reconcileMemoryIndex(options.workspaceId, options.roots)
  if (!isWorkspaceMemoryEnabled(options.workspaceId) || options.signal?.aborted) return []
  const [lexical, semantic, pinned] = await Promise.all([
    searchMemoryIndexLexical(options.workspaceId, options.query, options.roots, candidateLimit),
    searchMemoryIndexVector(options.workspaceId, options.query, options.roots, candidateLimit, options.signal),
    searchMemoryIndexLexical(options.workspaceId, '', options.roots, 10),
  ])
  if (!isWorkspaceMemoryEnabled(options.workspaceId) || options.signal?.aborted) return []
  const results = boundResults(
    mergeCandidates(lexical, semantic, pinned, options.query),
    limit,
    Math.max(2_000, Math.min(options.maxChars ?? MAX_CONTEXT_CHARS, 32 * 1024))
  )
  if (options.markUsed) {
    markLocalMemoriesUsed(
      options.workspaceId,
      results.filter((hit) => hit.kind === 'local').map((hit) => hit.id)
    )
  }
  return results
}
