import { embedTexts } from '../../local-ml/embedding-service'
import { calibratedVectorRelevance } from '../../memory/relevance'
import { readyRuntimeAsset } from '../../runtime-assets/app-service'
import type { HistoryReranker } from './search'

/**
 * Semantic reranking of history candidates with the local embedding model, at query time only: messages are never
 * embedded ahead of time, so indexing stays cheap. Used only when the optional local ML component is already
 * installed, within a time budget; anything else leaves text relevance alone.
 */
export const HISTORY_SEMANTIC = { budgetMs: 800, maxCandidates: 40 } as const

const dot = (left: readonly number[], right: readonly number[]) => {
  let sum = 0
  for (let index = 0; index < left.length; index++) sum += left[index]! * (right[index] ?? 0)
  return sum
}

export function localEmbeddingReranker(budgetMs: number = HISTORY_SEMANTIC.budgetMs): HistoryReranker {
  return async (query, candidates) => {
    const scores = new Map<number, number>()
    if (!candidates.length) return scores
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('history semantic budget'))
        resolve(null)
      }, budgetMs)
    })
    try {
      const work = (async () => {
        // Read-only check: a search never starts the component's installation.
        await readyRuntimeAsset('local-ml-runtime')
        if (controller.signal.aborted) return null
        const picked = candidates.slice(0, HISTORY_SEMANTIC.maxCandidates)
        const vectors = await embedTexts([query, ...picked.map((candidate) => candidate.text)], {
          signal: controller.signal,
        })
        return vectors && vectors.length === picked.length + 1 ? { picked, vectors } : null
      })().catch(() => null)
      const result = await Promise.race([work, expired])
      if (!result) return scores
      const [queryVector, ...rest] = result.vectors
      rest.forEach((vector, index) => {
        // MiniLM vectors are unit-normalized: the dot product is the cosine.
        scores.set(result.picked[index]!.key, calibratedVectorRelevance(dot(queryVector!, vector)))
      })
      return scores
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
