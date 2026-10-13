import type {
  MobileChatSetup,
  MobileConversation,
  MobileLists,
  MobileRuntime,
  MobileWorkspace,
  FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import { effortLabel } from '../fleet/format'
import type { StatusLine } from '../fleet/selectors'
import type { Text, Translate } from '../i18n/translate'
import { allConversations } from './state'

export type DayGroup = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older'

/** Calendar days, as chat histories group them. */
export function dayGroup(at: string, now: number): Exclude<DayGroup, 'pinned'> {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const time = Date.parse(at)
  if (time >= today.getTime()) return 'today'
  const days = Math.ceil((today.getTime() - time) / 86_400_000)
  if (days <= 1) return 'yesterday'
  if (days <= 7) return 'week'
  if (days <= 30) return 'month'
  return 'older'
}

const byRecent = (list: MobileConversation[]) =>
  [...list].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0))
const matches = (query: string, ...fields: (string | null)[]) =>
  !query || fields.some((field) => field?.toLowerCase().includes(query))

/** Chats newest first under their day, pinned ones first of all. */
export function groupByDay(
  chats: MobileConversation[],
  now: number
): { group: DayGroup; chats: MobileConversation[] }[] {
  const groups: { group: DayGroup; chats: MobileConversation[] }[] = []
  const pinned = byRecent(chats.filter((chat) => chat.pinned))
  if (pinned.length) groups.push({ group: 'pinned', chats: pinned })
  for (const chat of byRecent(chats.filter((item) => !item.pinned))) {
    const group = dayGroup(chat.lastActivityAt, now)
    const last = groups.at(-1)
    if (last?.group === group) last.chats.push(chat)
    else groups.push({ group, chats: [chat] })
  }
  return groups
}

export const searchChats = (lists: MobileLists | null, query: string) => {
  const q = query.trim().toLowerCase()
  return (lists?.chats ?? []).filter((chat) => matches(q, chat.name))
}

export type WorkspaceGroup = { workspace: MobileWorkspace; chats: MobileConversation[] }

/** Workspaces with the most recent work first; a search matches workspace names and the names of their chats. */
export function workspaceGroups(lists: MobileLists | null, query: string): WorkspaceGroup[] {
  const q = query.trim().toLowerCase()
  const last = (workspace: MobileWorkspace) =>
    workspace.conversations.reduce((latest, chat) => (chat.lastActivityAt > latest ? chat.lastActivityAt : latest), '')
  return [...(lists?.workspaces ?? [])]
    .sort((a, b) => (last(a) < last(b) ? 1 : last(a) > last(b) ? -1 : a.name.localeCompare(b.name)))
    .map((workspace) => ({
      workspace,
      chats: byRecent(
        matches(q, workspace.name)
          ? workspace.conversations
          : workspace.conversations.filter((chat) => matches(q, chat.name))
      ),
    }))
    .filter((group) => !q || group.chats.length > 0 || matches(q, group.workspace.name))
}

/** How many results a search has in the Workspaces tab: each workspace counts at least once. */
export const workspaceResultCount = (groups: WorkspaceGroup[]) =>
  groups.reduce((count, group) => count + Math.max(1, group.chats.length), 0)

export const isWaitingChat = (chat: MobileConversation) => chat.status === 'waiting' || chat.status === 'asking'

/** Chats that wait on you, those that waited longest first. */
export const waitingChats = (lists: MobileLists | null) =>
  allConversations(lists)
    .filter(isWaitingChat)
    .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? -1 : 1))

/** Where a chat is, for its header: the workspace and branch, or the server for a chat with no workspace. */
export function chatPlace(chat: MobileConversation, serverName: string, t: Translate): string {
  return chat.workspaceName
    ? `${chat.workspaceName} · ${chat.branch ?? ''}`.replace(/ · $/, '')
    : t('chat.place', { server: serverName })
}

/** One line on what a chat is doing, for the drawer and its header; idle chats say where they are. */
export function chatStatusLine(
  chat: MobileConversation,
  runtime: MobileRuntime | null,
  serverName: string,
  { t }: Pick<Text, 't'>
): StatusLine {
  if (runtime?.plan) return { text: t('chat.status.plan'), tone: 'cue' }
  switch (chat.status) {
    case 'waiting':
      return { text: t('status.permission'), tone: 'cue' }
    case 'asking':
      return { text: t('status.question'), tone: 'cue' }
    case 'working':
      return { text: runtime?.compacting ? t('status.compacting') : t('chat.status.working'), tone: 'plain' }
    case 'error':
      return { text: t('chat.status.error'), tone: 'plain' }
    default:
      return { text: chatPlace(chat, serverName, t), tone: 'plain' }
  }
}

/** The model a chat uses and its effort, as its composer pill shows them. */
export function chatSetupSummary(
  setup: MobileChatSetup,
  option: FleetSelectionOption | null,
  defaultOption: FleetSelectionOption | null,
  t: Translate
): string {
  const model = setup.selection
    ? (option?.modelLabel ?? setup.selection.modelId)
    : defaultOption
      ? t('chat.setup.defaultModel', { model: defaultOption.modelLabel })
      : t('chat.setup.default')
  if (setup.reasoning === 'ultra' || setup.reasoning === 'maestrly-ultra') return `${model} · ${t('chat.setup.ultra')}`
  return setup.reasoning && setup.reasoning !== 'off' ? `${model} · ${effortLabel(setup.reasoning, t)}` : model
}

/** The option of a chat's model, in what the host offers. */
export const optionFor = (
  options: FleetSelectionOption[],
  selection: { providerId: string; modelId: string } | null
) =>
  selection
    ? (options.find((option) => option.providerId === selection.providerId && option.modelId === selection.modelId) ??
      null)
    : null

/** Tokens from what someone types: 150k, 1.5M or a plain number; null when it is not one. */
export function parseTokenCount(raw: string): number | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*([kKmM])?\s*$/.exec(raw)
  if (!match) return null
  const unit = match[2] ? (match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1
  const value = Number(match[1].replace(',', '.')) * unit
  return Number.isFinite(value) ? Math.round(value) : null
}

/** The efforts a chat may choose for a model, Ultra apart: Default (`off`) first. */
export function chatEffortChoices(option: FleetSelectionOption | null): string[] {
  const efforts = (option?.efforts ?? []).filter((effort) => effort !== 'ultra' && effort !== 'maestrly-ultra')
  return efforts.length ? ['off', ...efforts] : []
}
