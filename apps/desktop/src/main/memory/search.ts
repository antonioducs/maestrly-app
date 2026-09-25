import type { MemoryType, SharedMemoryType } from '../../shared/memory'
import {
  memoryIndexDocumentFrequencies,
  searchMemoryIndexStems,
  searchMemoryIndexVector,
  type IndexedMemoryCandidate,
} from './index'
import {
  calibratedVectorRelevance,
  cosineFromL2,
  lexicalRelevance,
  memorySnippet,
  passesRecallFloor,
  passesSearchFloor,
  queryStems,
} from './relevance'
import type { MemorySpace } from './spaces'

export interface SpaceSearchHit {
  kind: 'local' | 'shared'
  id: string
  title: string
  type: MemoryType | SharedMemoryType
  relevance: number
  snippet: string
  pinned: boolean
  updatedAt?: number
  repo?: string
  path?: string
  startLine?: number
  endLine?: number
}

export interface SpaceSearchOptions {
  mode: 'recall' | 'search'
  limit: number
  excludeIds?: ReadonlySet<string>
  signal?: AbortSignal
  vectorBudgetMs?: number
}

const SNIPPET_CHARS = { recall: 400, search: 300 } as const

async function vectorCandidates(space: MemorySpace, query: string, options: SpaceSearchOptions) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      searchMemoryIndexVector(space.id, query, space.roots, 20, options.signal),
      new Promise<IndexedMemoryCandidate[]>((resolve) => {
        timer = setTimeout(() => resolve([]), options.vectorBudgetMs ?? 800)
      }),
    ])
  } catch {
    return [] // Text-only relevance stays available.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Relevance-floored search over one memory space; `recall` is stricter than `search`. */
export async function searchMemorySpace(
  space: MemorySpace,
  query: string,
  options: SpaceSearchOptions
): Promise<SpaceSearchHit[]> {
  const stems = queryStems(query)
  if (stems.length === 0) return []
  const [lexical, frequencies, vectors] = await Promise.all([
    searchMemoryIndexStems(space.id, stems, space.roots, 40),
    memoryIndexDocumentFrequencies(space.id, stems, space.roots),
    vectorCandidates(space, query, options),
  ])
  const distances = new Map<string, number>()
  for (const candidate of vectors) {
    const key = `${candidate.kind}:${candidate.id}`
    if (candidate.distance !== undefined && !((distances.get(key) ?? Number.POSITIVE_INFINITY) <= candidate.distance))
      distances.set(key, candidate.distance)
  }
  const best = new Map<string, SpaceSearchHit>()
  for (const candidate of [...lexical, ...vectors]) {
    if (options.excludeIds?.has(candidate.id)) continue
    const key = `${candidate.kind}:${candidate.id}`
    const match = lexicalRelevance(stems, frequencies.df, frequencies.total, candidate)
    const distance = distances.get(key)
    const vector = distance === undefined ? 0 : calibratedVectorRelevance(cosineFromL2(distance))
    const passes =
      options.mode === 'recall' ? passesRecallFloor(match, stems.length, vector) : passesSearchFloor(match, vector)
    if (!passes) continue
    const relevance = Math.max(match.relevance, vector)
    if ((best.get(key)?.relevance ?? -1) >= relevance) continue
    best.set(key, {
      kind: candidate.kind,
      id: candidate.id,
      title: candidate.title,
      type: candidate.type,
      relevance,
      snippet: memorySnippet(
        candidate.content,
        match.matched.length ? match.matched : stems,
        SNIPPET_CHARS[options.mode]
      ),
      pinned: candidate.pinned === true,
      ...(candidate.updatedAt ? { updatedAt: candidate.updatedAt } : {}),
      ...(candidate.repo ? { repo: candidate.repo } : {}),
      ...(candidate.path ? { path: candidate.path } : {}),
      ...(candidate.startLine ? { startLine: candidate.startLine } : {}),
      ...(candidate.endLine ? { endLine: candidate.endLine } : {}),
    })
  }
  return [...best.values()]
    .sort((a, b) => b.relevance - a.relevance || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, options.limit)
}
