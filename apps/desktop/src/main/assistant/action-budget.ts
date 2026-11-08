/**
 * How many targets the assistant may act on in one turn without asking. The person's message is the request: up to
 * three distinct targets (conversations, remote conversations, bots) go through; from the fourth on, one card asks
 * about the rest, and "allow the rest" lets the turn finish without asking again.
 */
import type { ChatQuestion } from '../../shared/chat'

export const ASSISTANT_FREE_TARGETS_PER_TURN = 3
/** Turns whose budget is kept; a turn that ended without clearing falls off the oldest end. */
const MAX_TURNS = 64

type AskQuestion = (questions: ChatQuestion[]) => Promise<string[][]>

export type AssistantActionKind = 'send' | 'bot-send' | 'answer' | 'respond'

export interface AssistantAction {
  kind: AssistantActionKind
  targetName: string
  preview: string
}

export function createActionBudget(limit = ASSISTANT_FREE_TARGETS_PER_TURN) {
  const turns = new Map<string, { targets: Set<string>; released: boolean }>()
  const turn = (originKey: string) => {
    let entry = turns.get(originKey)
    if (!entry) {
      entry = { targets: new Set(), released: false }
      turns.set(originKey, entry)
      if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value as string)
    }
    return entry
  }
  return {
    /** 'free' up to `limit` distinct targets per turn, and for a target already reached; else 'confirm'. */
    check(originKey: string, targetRef: string): 'free' | 'confirm' {
      const entry = turn(originKey)
      if (entry.released || entry.targets.has(targetRef)) {
        entry.targets.add(targetRef)
        return 'free'
      }
      if (entry.targets.size < limit) {
        entry.targets.add(targetRef)
        return 'free'
      }
      return 'confirm'
    },
    /** The person confirmed this target: it stays free for the rest of the turn. */
    grant(originKey: string, targetRef: string): void {
      turn(originKey).targets.add(targetRef)
    },
    /** "Allow the rest of this request". */
    release(originKey: string): void {
      turn(originKey).released = true
    },
    clear(originKey: string): void {
      turns.delete(originKey)
    },
  }
}

export type ActionBudget = ReturnType<typeof createActionBudget>

export const assistantActionBudget: ActionBudget = createActionBudget()

const QUESTION_KEY: Record<AssistantActionKind, string> = {
  send: 'assistant.confirmSend',
  'bot-send': 'assistant.confirmBotSend',
  answer: 'assistant.confirmAnswer',
  respond: 'assistant.confirmRespond',
}

const ONCE_KEY: Record<AssistantActionKind, string> = {
  send: 'assistant.confirmOnce',
  'bot-send': 'assistant.confirmOnce',
  answer: 'assistant.confirmAnswerOnce',
  respond: 'assistant.confirmApprove',
}

/**
 * One card in the chat for an action the budget does not cover, or for an approval. Without `allowRelease` the card
 * has no "allow the rest" option (approvals are confirmed one by one). Dismissal cancels.
 */
export async function confirmAssistantAction(
  askQuestion: AskQuestion,
  action: AssistantAction,
  opts: { allowRelease?: boolean } = {}
): Promise<'once' | 'release' | 'cancel'> {
  const { tMain } = await import('../i18n')
  const t = tMain('main')
  const labels = {
    once: t(ONCE_KEY[action.kind]),
    release: t('assistant.confirmRelease'),
    cancel: t('assistant.confirmCancel'),
  }
  const allowRelease = opts.allowRelease !== false
  try {
    const answers = await askQuestion([
      {
        header: t('assistant.confirmHeader'),
        question: t(QUESTION_KEY[action.kind], { target: action.targetName, preview: action.preview }),
        options: [
          { label: labels.once },
          ...(allowRelease ? [{ label: labels.release }] : []),
          { label: labels.cancel },
        ],
      },
    ])
    const choice = answers[0]?.[0]
    if (choice === labels.once) return 'once'
    if (allowRelease && choice === labels.release) return 'release'
    return 'cancel'
  } catch {
    return 'cancel'
  }
}

/** Whether the assistant may act on `targetRef` now: free within the budget, else after the person confirms. */
export async function admitAssistantAction(
  askQuestion: AskQuestion,
  originKey: string,
  targetRef: string,
  action: AssistantAction,
  budget: ActionBudget = assistantActionBudget
): Promise<boolean> {
  if (budget.check(originKey, targetRef) === 'free') return true
  const answer = await confirmAssistantAction(askQuestion, action)
  if (answer === 'cancel') return false
  if (answer === 'release') budget.release(originKey)
  else budget.grant(originKey, targetRef)
  return true
}
