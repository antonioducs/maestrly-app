import { automationTaskContext, type AutomationPromptCard, type ExecutionEnvelope } from '@maestrly/protocol'

/** Card context carried by the envelope, for executors that must build a prompt without a rendered template. */
export function promptCard(envelope: ExecutionEnvelope): AutomationPromptCard {
  return {
    id: envelope.cardId,
    title: envelope.snapshot.title,
    description: envelope.snapshot.description,
    acceptanceCriteria: envelope.snapshot.acceptanceCriteria,
    boardId: envelope.boardId,
    projectId: envelope.projectId,
  }
}

/** Fallback prompt for jobs that carry no server-rendered prompt: card context plus workspace state. */
export function fallbackPrompt(envelope: ExecutionEnvelope): string {
  return automationTaskContext(promptCard(envelope), 'unknown', {
    repositoryBranch: envelope.snapshot.repositoryBindingId ? envelope.snapshot.repositoryBranch : null,
  })
}
