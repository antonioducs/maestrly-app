/**
 * What the assistant does while the person talks to it, for the voice screen: the tools of the assistant conversation
 * and those the Realtime voice calls, as a short list that starts over with each request. Pure: the session feeds it
 * stream and call events.
 */
import type { ChatStreamEvent, ToolState } from '../../../../shared/chat'
import { baseToolName } from '@/lib/agent-activity'
import type { RealtimeToolEvent } from './realtime-client'

export type VoiceActivityStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

export interface VoiceActivityItem {
  /** The tool call's id. */
  id: string
  /** The assistant conversation's tools, or the Realtime voice's own. */
  source: 'chat' | 'voice'
  toolName: string
  input: unknown
  /** The chat tool's state, for its label. */
  state: ToolState | null
  status: VoiceActivityStatus
  startedAt: number
  endedAt: number | null
}

export interface VoiceActivity {
  /** What runs for the latest request, oldest first. */
  items: VoiceActivityItem[]
  /** Everything done since the call started, oldest first: the summary when it ends. */
  done: VoiceActivityItem[]
}

export const EMPTY_VOICE_ACTIVITY: VoiceActivity = { items: [], done: [] }

const MAX_ITEMS = 12
const MAX_DONE = 30
/** Cards the voice screen shows on its own (a question), or bookkeeping the person does not follow. */
const HIDDEN_TOOLS = new Set(['ask_question', 'todo_write'])

const isOpen = (item: VoiceActivityItem) => item.status === 'running' || item.status === 'waiting'

function chatStatus(state: ToolState): VoiceActivityStatus {
  switch (state.status) {
    case 'pending':
    case 'running':
      return 'running'
    case 'awaiting-permission':
      return 'waiting'
    case 'completed':
      return 'done'
    case 'error':
      return state.error === 'Aborted' ? 'cancelled' : 'failed'
    case 'denied':
      return 'cancelled'
  }
}

function settle(activity: VoiceActivity, id: string, patch: Partial<VoiceActivityItem>, now: number): VoiceActivity {
  let finished: VoiceActivityItem | null = null
  const items = activity.items.map((item) => {
    if (item.id !== id) return item
    const next = { ...item, ...patch }
    if (next.status !== 'running' && next.status !== 'waiting') next.endedAt ??= now
    if (next.status === 'done' && item.status !== 'done') finished = next
    return next
  })
  return {
    items,
    done: finished ? [...activity.done, finished].slice(-MAX_DONE) : activity.done,
  }
}

function add(activity: VoiceActivity, item: VoiceActivityItem): VoiceActivity {
  return { ...activity, items: [...activity.items, item].slice(-MAX_ITEMS) }
}

/** A tool of the assistant conversation started, got its input, or changed state. */
export function voiceActivityFromChat(activity: VoiceActivity, event: ChatStreamEvent, now: number): VoiceActivity {
  if (event.kind === 'tool-input-start' || event.kind === 'tool-call') {
    if (HIDDEN_TOOLS.has(baseToolName(event.toolName))) return activity
    const input = event.kind === 'tool-call' ? event.input : undefined
    if (activity.items.some((item) => item.id === event.toolCallId))
      return input === undefined ? activity : settle(activity, event.toolCallId, { input }, now)
    return add(activity, {
      id: event.toolCallId,
      source: 'chat',
      toolName: event.toolName,
      input,
      state: { status: 'running' },
      status: 'running',
      startedAt: now,
      endedAt: null,
    })
  }
  if (event.kind === 'tool-state') {
    if (!activity.items.some((item) => item.id === event.toolCallId)) return activity
    return settle(activity, event.toolCallId, { state: event.state, status: chatStatus(event.state) }, now)
  }
  if (event.kind === 'aborted' || event.kind === 'error') {
    let next = activity
    for (const item of activity.items)
      if (item.source === 'chat' && isOpen(item)) next = settle(next, item.id, { status: 'cancelled' }, now)
    return next
  }
  return activity
}

function voiceOutcome(output: string | undefined): VoiceActivityStatus {
  try {
    const value = JSON.parse(output ?? '{}') as Record<string, unknown>
    if (value.error) return 'failed'
    // The assistant waits for the person: a confirmation the voice reads, or one only the card takes.
    if (value.needsConfirmation || value.confirmOnCard) return 'waiting'
  } catch {
    /* plain text: the overview */
  }
  return 'done'
}

/** A tool the Realtime voice called started or returned. */
export function voiceActivityFromCall(activity: VoiceActivity, event: RealtimeToolEvent, now: number): VoiceActivity {
  if (!event.done) {
    if (activity.items.some((item) => item.id === event.callId)) return activity
    return add(activity, {
      id: event.callId,
      source: 'voice',
      toolName: event.name,
      input: event.args,
      state: null,
      status: 'running',
      startedAt: now,
      endedAt: null,
    })
  }
  const status = voiceOutcome(event.output)
  let next = settle(activity, event.callId, { status }, now)
  // The person's answer let the request it waited on go on.
  if (event.name === 'answer_confirmation' && status === 'done') next = questionsSettled(next, now)
  return next
}

/** No card waits for the person any more: the requests that waited on one go on. */
export function questionsSettled(activity: VoiceActivity, now: number): VoiceActivity {
  let next = activity
  for (const item of activity.items)
    if (item.source === 'voice' && item.status === 'waiting') next = settle(next, item.id, { status: 'done' }, now)
  return next
}

/** The person asks something new: what finished for the previous request leaves the list. */
export function newVoiceTurn(activity: VoiceActivity): VoiceActivity {
  return { ...activity, items: activity.items.filter(isOpen) }
}

/** A call starts: its summary counts only what it did. */
export function startVoiceCall(activity: VoiceActivity): VoiceActivity {
  return { ...activity, done: [] }
}

/** The call ended: its own tools stop with it; the assistant's turn may go on. */
export function endVoiceCall(activity: VoiceActivity, now: number): VoiceActivity {
  let next = activity
  for (const item of activity.items)
    if (item.source === 'voice' && isOpen(item)) next = settle(next, item.id, { status: 'cancelled' }, now)
  return next
}
