import type { ChatCompactionProgress, ChatContextSnapshot, ChatMessage, ChatModelRef } from './chat'

export function sameContextModel(a: ChatModelRef | null | undefined, b: ChatModelRef | null | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId
}

export function isMainMessage(message: ChatMessage): boolean {
  return (
    !message.internal &&
    !message.reviewLoop &&
    message.source !== 'chatgpt-web-review-loop' &&
    message.source !== 'maestrly-review-loop' &&
    (!message.executionScope || message.executionScope.kind === 'conversation')
  )
}

/** Stop at context boundaries instead of resurrecting an older matching model's observation. */
export function selectContextObservation(
  messages: readonly ChatMessage[],
  target: {
    conversationId: string
    model: ChatModelRef | null
    streaming: boolean
    compacting?: boolean
    after?: number
  }
): { snapshot?: ChatContextSnapshot; progress?: ChatCompactionProgress } {
  if (!target.model) return {}
  let snapshot: ChatContextSnapshot | undefined
  let progress: ChatCompactionProgress | undefined
  let latestAssistantId: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.conversationId !== target.conversationId || !isMainMessage(message)) continue
    const boundary = message.parts.some((part) => part.type === 'compaction')
    if (message.role === 'assistant') {
      latestAssistantId ??= message.id
      const currentProgress =
        message.compactionProgress?.model && !sameContextModel(message.compactionProgress.model, target.model)
          ? undefined
          : message.compactionProgress
      const conversationProgress =
        currentProgress?.scope === 'conversation' && sameContextModel(currentProgress.model, target.model)
      if (message.model && !sameContextModel(message.model, target.model) && !conversationProgress) break
      const candidate = sameContextModel(message.contextSnapshot?.model, target.model)
        ? message.contextSnapshot
        : undefined
      if (message.contextSnapshot && !candidate && !conversationProgress) break
      // Legacy markers have no observation timestamp; do not assume their attached sample survived compaction.
      if (boundary && !currentProgress) break
      if (!progress && currentProgress && currentProgress.updatedAt >= (target.after ?? 0)) {
        const active = currentProgress.status === 'running' || currentProgress.status === 'retrying'
        const ended =
          message.id !== latestAssistantId || (!conversationProgress && (!!message.finishReason || !!message.error))
        progress =
          active && (ended || (!target.streaming && !target.compacting))
            ? { ...currentProgress, status: message.error || message.finishReason === 'error' ? 'failed' : 'cancelled' }
            : currentProgress
      }
      if (
        !snapshot &&
        currentProgress?.status === 'completed' &&
        currentProgress.updatedAt >= (target.after ?? 0) &&
        (!candidate || currentProgress.updatedAt >= candidate.observedAt)
      ) {
        // A completed summary can precede the next measured provider sample.
        if (currentProgress.afterTokens != null) {
          snapshot = {
            model: target.model,
            sequence: candidate?.sequence ?? 0,
            ...(candidate?.modelContextWindow != null ? { modelContextWindow: candidate.modelContextWindow } : {}),
            usedTokens: currentProgress.afterTokens,
            quality: currentProgress.afterQuality ?? 'estimated',
            observedAt: currentProgress.updatedAt,
          }
        }
      } else if (!snapshot && candidate && candidate.observedAt >= (target.after ?? 0)) {
        snapshot = candidate
      }
      if (currentProgress?.status === 'completed') break
    }
    if (boundary || (snapshot && progress)) break
  }
  return { snapshot, progress }
}
