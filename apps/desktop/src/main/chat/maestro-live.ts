import { randomUUID } from 'node:crypto'
import type { StructuredAgentMentionDraft } from '../../shared/chat-agent-mentions'
import {
  appendMaestroLiveEnvelope,
  MAESTRO_LIVE_DEFAULT_CLAIM_BYTES,
  MAESTRO_LIVE_DEFAULT_CLAIM_MESSAGES,
  type MaestroLiveCheckpointDelivery,
  type MaestroLiveEvent,
  type MaestroLivePostResult,
  type MaestroLiveRunStatus,
  type MaestroLiveState,
} from '../../shared/maestro-live'
import {
  bindMaestroLiveAssistantMessage,
  cancelMaestroLiveMessage,
  cancelPendingMaestroLiveMessages,
  claimPendingMaestroLiveMessages,
  createMaestroLiveRun,
  finishMaestroLiveRun,
  getMaestroLiveRun,
  listMaestroLiveMessages,
  markMaestroLiveCheckpointEmbedded,
  postMaestroLiveMessage,
  releaseMaestroLiveCheckpoint,
} from './maestro-live-store'

export interface MaestroLiveRunPort {
  readonly runId: string
  readonly conversationId: string
  state(): MaestroLiveState
  bindAssistantMessage(messageId: string): void
  post(text: string, agentMentions?: readonly StructuredAgentMentionDraft[]): MaestroLivePostResult
  cancelMessage(messageId: string): boolean
  embedPending(checkpointId: string, workerOutput: string): MaestroLiveCheckpointDelivery
  finish(status: Exclude<MaestroLiveRunStatus, 'active'>): void
  cancelPending(): void
}

export function createMaestroLiveRunPort(input: {
  conversationId: string
  assistantMessageId?: string | null
  emit: (event: MaestroLiveEvent) => void
}): MaestroLiveRunPort {
  const run = createMaestroLiveRun({
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
  })
  const currentState = (): MaestroLiveState => ({
    run: getMaestroLiveRun(run.id)!,
    messages: listMaestroLiveMessages(run.id),
  })
  return {
    runId: run.id,
    conversationId: input.conversationId,
    state: currentState,
    bindAssistantMessage(messageId) {
      const next = bindMaestroLiveAssistantMessage(run.id, messageId)
      if (next) input.emit({ kind: 'run-updated', run: next })
    },
    post(text, agentMentions) {
      const result = postMaestroLiveMessage({ runId: run.id, text, agentMentions })
      if (result.ok) input.emit({ kind: 'message-posted', run: result.run, message: result.message })
      return result
    },
    cancelMessage(messageId) {
      const message = cancelMaestroLiveMessage(run.id, messageId)
      if (message?.status !== 'cancelled') return false
      input.emit({ kind: 'messages-updated', run: getMaestroLiveRun(run.id)!, messages: [message] })
      return true
    },
    embedPending(checkpointId, workerOutput) {
      const deliveryId = `live_${randomUUID()}`
      const messages = claimPendingMaestroLiveMessages({
        runId: run.id,
        checkpointId,
        maxMessages: MAESTRO_LIVE_DEFAULT_CLAIM_MESSAGES,
        maxBytes: MAESTRO_LIVE_DEFAULT_CLAIM_BYTES,
      })
      if (messages.length === 0) return { deliveryId, messageIds: [], output: workerOutput }
      try {
        const output = appendMaestroLiveEnvelope(workerOutput, deliveryId, messages)
        const embedded = markMaestroLiveCheckpointEmbedded(run.id, checkpointId)
        input.emit({ kind: 'messages-updated', run: getMaestroLiveRun(run.id)!, messages: embedded })
        return { deliveryId, messageIds: embedded.map((message) => message.id), output }
      } catch (error) {
        releaseMaestroLiveCheckpoint(run.id, checkpointId)
        throw error
      }
    },
    finish(status) {
      const next = finishMaestroLiveRun(run.id, status)
      if (next) input.emit({ kind: 'messages-updated', run: next, messages: listMaestroLiveMessages(run.id) })
    },
    cancelPending() {
      const messages = cancelPendingMaestroLiveMessages(run.id)
      input.emit({ kind: 'messages-updated', run: getMaestroLiveRun(run.id)!, messages })
    },
  }
}

export function maestroLiveState(port: MaestroLiveRunPort | undefined): MaestroLiveState | null {
  return port?.state() ?? null
}
