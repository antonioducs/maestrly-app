import { useEffect, useMemo, useState } from 'react'
import { TURN_TERMINAL, type BotTurn } from '@maestrly/host-protocol'
import { estimatedCostOfUsage, type ChatModelMeta, type ContextUsage } from '@maestrly/chat-ui'

/** The catalogue entry for a model id as the Host names it (`gpt-5-codex`, `fixture-small`…). */
export function metaForModel(catalogue: Record<string, ChatModelMeta>, modelId: string | undefined): ChatModelMeta | null {
  if (!modelId) return null
  if (catalogue[`openai/${modelId}`]) return catalogue[`openai/${modelId}`]
  const key = Object.keys(catalogue).find((candidate) => candidate.endsWith(`/${modelId}`))
  return key ? catalogue[key] : null
}

/**
 * What the meter shows for a conversation: how much of the window the last finished turn used
 * (the guest's own figure when it reports one), and the estimated cost of every turn on the
 * page, priced with the public catalogue when it knows the model.
 */
export function contextMeter(turns: BotTurn[], catalogue: Record<string, ChatModelMeta>, currentModel: string | undefined) {
  const finished = turns.filter((turn) => TURN_TERMINAL.has(turn.status) && turn.usage).sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''))
  const last = finished.at(-1)
  const usage: ContextUsage | null = last?.usage
    ? { input: last.usage.inputTokens ?? 0, output: last.usage.outputTokens ?? 0, contextInput: last.usage.contextTokens ?? last.usage.inputTokens ?? 0, contextOutput: 0 }
    : null
  const catalogueMeta = metaForModel(catalogue, last?.model?.model ?? currentModel)
  // The guest's window wins: it knows the exact model variant; the catalogue is the fallback.
  const meta: ChatModelMeta | null = last?.usage?.modelContextWindow ? { ...catalogueMeta, contextWindow: last.usage.modelContextWindow } : catalogueMeta
  let cost: number | null = null
  for (const turn of finished) {
    const priced = estimatedCostOfUsage(
      { input: (turn.usage!.inputTokens ?? 0) - (turn.usage!.cachedInputTokens ?? 0), output: turn.usage!.outputTokens ?? 0, cacheRead: turn.usage!.cachedInputTokens ?? 0 },
      metaForModel(catalogue, turn.model?.model ?? currentModel)
    )
    if (priced != null) cost = (cost ?? 0) + priced
  }
  return { usage, meta, cost }
}

export function useModelMeta(): Record<string, ChatModelMeta> {
  const [catalogue, setCatalogue] = useState<Record<string, ChatModelMeta>>({})
  useEffect(() => {
    let alive = true
    window.bot
      .modelMeta()
      .then((meta) => alive && setCatalogue(meta))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return catalogue
}

export function useContextMeter(turns: BotTurn[], currentModel: string | undefined) {
  const catalogue = useModelMeta()
  return useMemo(() => contextMeter(turns, catalogue, currentModel), [turns, catalogue, currentModel])
}
