import { autonomousPolicy,AutonomousInteractionError } from './autonomous'
import { emitChatHost } from './host-events'
/**
 * Broker for ask_question options and free-text answers, following the PermissionBroker pattern.
 * Tool execution calls ask() and waits on a deferred promise until the user answers the chat card
 * through chat:question-respond → reply(). Questions already travel in streamed/persisted tool-call
 * input, so no separate question payload event is needed. Keep a minimal snapshot to restore ChatView
 * when it missed those deltas. Answers are string[][]: selected labels or free text per question.
 * Dismissal or abort resolves with [] so the tool returns as dismissed and the turn can continue.
 */
import { EventEmitter } from 'node:events'
import type { ChatQuestion, PendingChatQuestion } from '../../shared/chat'

interface Pending {
  conversationId: string
  messageId: string
  questions: ChatQuestion[]
  resolve: (answers: string[][]) => void
}

interface AskInput {
  conversationId: string
  messageId: string
  toolCallId: string
  questions: ChatQuestion[]
  /** Cancel this specific question and resolve it as dismissed. */
  signal?: AbortSignal
}

export class QuestionBroker extends EventEmitter {
  private pending = new Map<string, Pending>() // key = unique toolCallId

  /** Called by ask_question execution. Wait for an answer, or resolve [] on dismissal/abort.
   *  Emit 'asked' to mark the conversation as needing attention (asking status, sound and badge). */
  ask(input: AskInput): Promise<string[][]> {
    if(autonomousPolicy(input.conversationId))return Promise.reject(new AutonomousInteractionError())
    if (input.signal?.aborted) return Promise.resolve([])
    let entry!: Pending
    let cancel = (): void => {}
    const p = new Promise<string[][]>((resolve) => {
      entry = {
        conversationId: input.conversationId,
        messageId: input.messageId,
        questions: input.questions,
        resolve,
      }
      this.pending.set(input.toolCallId, entry)
    }).finally(() => {
      input.signal?.removeEventListener('abort', cancel)
      if (this.pending.get(input.toolCallId) === entry) this.pending.delete(input.toolCallId)
    })
    cancel = (): void => {
      if (this.pending.get(input.toolCallId) !== entry) return
      this.pending.delete(input.toolCallId)
      entry.resolve([])
      this.emit('answered', { conversationId: entry.conversationId, toolCallId: input.toolCallId })
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    this.emit('asked', { conversationId: input.conversationId, toolCallId: input.toolCallId })
    emitChatHost(input.conversationId,'question',{toolCallId:input.toolCallId,questions:input.questions})
    return p
  }

  /** Resolve a pending chat:question-respond request. answers = [] means dismissed. Emit 'answered'
   *  to restore working status. rejectConversation does not emit: abort/teardown already handles status. */
  reply(toolCallId: string, answers: string[][]): void {
    const p = this.pending.get(toolCallId)
    if (!p) return
    this.pending.delete(toolCallId)
    p.resolve(Array.isArray(answers) ? answers : [])
    this.emit('answered', { conversationId: p.conversationId, toolCallId })
  }

  /** Dismiss all pending questions on conversation abort/teardown; resolve [] so tools continue as dismissed. */
  rejectConversation(conversationId: string): void {
    for (const [id, p] of this.pending) {
      if (p.conversationId !== conversationId) continue
      this.pending.delete(id)
      p.resolve([])
    }
  }

  pendingFor(conversationId: string): string[] {
    return [...this.pending.entries()].filter(([, p]) => p.conversationId === conversationId).map(([id]) => id)
  }
  conversationFor(toolCallId:string):string|undefined{return this.pending.get(toolCallId)?.conversationId}

  /** Renderable snapshot of pending questions to remount ChatView without depending on missed deltas. */
  pendingQuestionsFor(conversationId: string): PendingChatQuestion[] {
    return [...this.pending.entries()]
      .filter(([, pending]) => pending.conversationId === conversationId)
      .map(([toolCallId, pending]) => ({
        messageId: pending.messageId,
        toolCallId,
        questions: pending.questions,
      }))
  }
}
