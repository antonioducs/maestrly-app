import type { MobileChatItem } from '@maestrly/bot-fleet-protocol'
import type { TranscriptRow } from './transcript-rows'

type UserItem = Extract<MobileChatItem, { kind: 'user' }>

/** Text as a search compares it: lower case, without accents, so “acao” finds “Ação”. */
export const searchKey = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function itemText(item: MobileChatItem): string[] {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
      return [item.text]
    case 'tool':
      return [item.name, item.target ?? '', item.output ?? '']
    case 'permission':
      return [item.title, item.tool?.target ?? '', item.detail ?? '']
    case 'question':
      return item.questions.flatMap((question) => [question.question, ...question.options.map((o) => o.label)])
    case 'help':
      return [item.reason]
    case 'system':
      return [item.text ?? '']
    case 'compaction':
      return [item.summary ?? '']
    case 'peer_out':
      return [item.text]
    case 'dispatch':
      return item.conversations.map((conversation) => conversation.title)
    default:
      return []
  }
}

/** What a search reads in a row: its text, and in an activity what each step did or said. */
export function rowText(row: TranscriptRow): string {
  switch (row.kind) {
    case 'item':
      return itemText(row.item).join('\n')
    case 'activity':
      return row.steps.flatMap((step) => (step.kind === 'tool' ? itemText(step.tool) : [step.item.text])).join('\n')
    case 'todos':
      return row.todos.map((todo) => todo.content).join('\n')
    case 'artifact':
      return row.artifact.title
    case 'files':
      return row.files.map((file) => file.name).join('\n')
  }
}

/** The indexes of the rows that hold the query, in the rows' order; none for a blank query. */
export function searchRows(rows: readonly (TranscriptRow | null)[], query: string): number[] {
  const key = searchKey(query.trim())
  if (!key) return []
  const found: number[] = []
  rows.forEach((row, index) => {
    if (row && searchKey(rowText(row)).includes(key)) found.push(index)
  })
  return found
}

/**
 * The message the person may edit, as on the desktop: their own last one, once nothing waits behind it. A bot's is
 * one the server took as an input (`input:` ids); a message sent from another conversation is not the person's.
 */
export function editableItemId(items: readonly MobileChatItem[], kind: 'bot' | 'chat'): string | null {
  let last: UserItem | null = null
  for (const item of items) {
    if (item.kind !== 'user') continue
    if (item.queued) return null
    last = item
  }
  // Only the person's own words: not a routine's, another conversation's, nor the instructions a bot sent there.
  if (last?.source !== 'owner' || 'fromConversation' in last || 'sentByBot' in last || last.attachmentError) return null
  return kind === 'bot' && !last.id.startsWith('input:') ? null : last.id
}
