import { afterEach, describe, expect, it, vi } from 'vitest'

const ready = vi.fn()
const embed = vi.fn()
vi.mock('../../src/main/runtime-assets/app-service', () => ({
  readyRuntimeAsset: (...args: unknown[]) => ready(...args),
}))
vi.mock('../../src/main/local-ml/embedding-service', () => ({ embedTexts: (...args: unknown[]) => embed(...args) }))

const { localEmbeddingReranker } = await import('../../src/main/chat/history-index/semantic')

const unit = (index: number) => Array.from({ length: 4 }, (_, at) => (at === index ? 1 : 0))
const candidates = [
  { key: 1, text: 'about oauth' },
  { key: 2, text: 'about lunch' },
]

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('history semantic reranker', () => {
  it('scores candidates by cosine with the query', async () => {
    ready.mockResolvedValue({ state: 'ready', path: '/runtime' })
    embed.mockResolvedValue([unit(0), unit(0), unit(1)])
    const scores = await localEmbeddingReranker()('authentication', candidates)
    expect(ready).toHaveBeenCalledWith('local-ml-runtime')
    expect(embed.mock.calls[0][0]).toEqual(['authentication', 'about oauth', 'about lunch'])
    expect(scores.get(1)).toBe(1)
    expect(scores.get(2)).toBe(0)
  })

  it('stays text-only when the local ML component is not installed', async () => {
    ready.mockRejectedValue(new Error('component required'))
    expect((await localEmbeddingReranker()('q', candidates)).size).toBe(0)
    expect(embed).not.toHaveBeenCalled()
  })

  it('gives up at the time budget and cancels the embedding', async () => {
    ready.mockResolvedValue({ state: 'ready', path: '/runtime' })
    let signal: AbortSignal | undefined
    embed.mockImplementation((_texts: string[], options: { signal: AbortSignal }) => {
      signal = options.signal
      return new Promise(() => undefined)
    })
    const started = Date.now()
    expect((await localEmbeddingReranker(30)('q', candidates)).size).toBe(0)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(signal?.aborted).toBe(true)
  })

  it('ignores an incomplete embedding result', async () => {
    ready.mockResolvedValue({ state: 'ready', path: '/runtime' })
    embed.mockResolvedValue([unit(0)])
    expect((await localEmbeddingReranker()('q', candidates)).size).toBe(0)
  })
})
