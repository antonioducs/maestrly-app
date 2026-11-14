import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../../src/shared/chat'
import {
  EMPTY_VOICE_ACTIVITY,
  endVoiceCall,
  newVoiceTurn,
  questionsSettled,
  startVoiceCall,
  type VoiceActivity,
  voiceActivityFromCall,
  voiceActivityFromChat,
} from '../../src/renderer/components/assistant/voice/voice-activity'

const chat = (activity: VoiceActivity, ...events: ChatStreamEvent[]) =>
  events.reduce((next, event, i) => voiceActivityFromChat(next, event, 1000 + i * 100), activity)
const summary = (activity: VoiceActivity) => activity.items.map((item) => `${item.toolName}:${item.status}`)

describe('the voice screen activity', () => {
  it('follows a tool of the assistant from its start to its result', () => {
    const activity = chat(
      EMPTY_VOICE_ACTIVITY,
      { kind: 'tool-input-start', messageId: 'm1', toolCallId: 't1', toolName: 'mcp__maestrly__bot_read' },
      { kind: 'tool-call', messageId: 'm1', toolCallId: 't1', toolName: 'mcp__maestrly__bot_read', input: { ref: 'b' } }
    )
    expect(activity.items).toEqual([expect.objectContaining({ id: 't1', status: 'running', input: { ref: 'b' } })])
    const done = chat(activity, {
      kind: 'tool-state',
      messageId: 'm1',
      toolCallId: 't1',
      state: { status: 'completed', output: 'ok' },
    })
    expect(done.items[0]).toMatchObject({ status: 'done', startedAt: 1000, endedAt: 1000 })
    expect(done.done.map((item) => item.id)).toEqual(['t1'])
  })

  it('leaves out the question card and the to-do list, and stops what an aborted turn left running', () => {
    const activity = chat(
      EMPTY_VOICE_ACTIVITY,
      { kind: 'tool-call', messageId: 'm1', toolCallId: 'q', toolName: 'mcp__maestrly__ask_question', input: {} },
      { kind: 'tool-call', messageId: 'm1', toolCallId: 'd', toolName: 'todo_write', input: {} },
      { kind: 'tool-call', messageId: 'm1', toolCallId: 'b', toolName: 'bash', input: { command: 'ls' } },
      { kind: 'tool-call', messageId: 'm1', toolCallId: 'w', toolName: 'webfetch', input: { url: 'https://a.b' } },
      {
        kind: 'tool-state',
        messageId: 'm1',
        toolCallId: 'w',
        state: { status: 'awaiting-permission' },
      },
      { kind: 'aborted', messageId: 'm1' }
    )
    expect(summary(activity)).toEqual(['bash:cancelled', 'webfetch:cancelled'])
  })

  it('tells a denied or aborted call from one that failed', () => {
    const activity = chat(
      EMPTY_VOICE_ACTIVITY,
      { kind: 'tool-call', messageId: 'm', toolCallId: 'a', toolName: 'bash', input: {} },
      { kind: 'tool-call', messageId: 'm', toolCallId: 'b', toolName: 'bash', input: {} },
      { kind: 'tool-call', messageId: 'm', toolCallId: 'c', toolName: 'bash', input: {} },
      { kind: 'tool-state', messageId: 'm', toolCallId: 'a', state: { status: 'error', error: 'Aborted' } },
      { kind: 'tool-state', messageId: 'm', toolCallId: 'b', state: { status: 'error', error: 'exit 1' } },
      { kind: 'tool-state', messageId: 'm', toolCallId: 'c', state: { status: 'denied' } }
    )
    expect(summary(activity)).toEqual(['bash:cancelled', 'bash:failed', 'bash:cancelled'])
  })

  it('follows the Realtime voice’s calls, waiting while the assistant needs a confirmation', () => {
    let activity = voiceActivityFromCall(
      EMPTY_VOICE_ACTIVITY,
      { callId: 'c1', name: 'ask_assistant', args: { request: 'trocar a conta' }, done: false },
      1000
    )
    activity = voiceActivityFromCall(
      activity,
      {
        callId: 'c1',
        name: 'ask_assistant',
        args: {},
        done: true,
        output: JSON.stringify({ needsConfirmation: { question: 'Trocar?', options: ['Sim', 'Não'] } }),
      },
      1500
    )
    expect(summary(activity)).toEqual(['ask_assistant:waiting'])
    activity = voiceActivityFromCall(
      activity,
      { callId: 'c2', name: 'answer_confirmation', args: {}, done: false },
      2000
    )
    activity = voiceActivityFromCall(
      activity,
      { callId: 'c2', name: 'answer_confirmation', args: {}, done: true, output: '{"reply":"Pronto."}' },
      2600
    )
    expect(summary(activity)).toEqual(['ask_assistant:done', 'answer_confirmation:done'])
    expect(activity.items[0].input).toEqual({ request: 'trocar a conta' })
  })

  it('marks a call that returned an error as failed, and the overview as done', () => {
    let activity = EMPTY_VOICE_ACTIVITY
    for (const [callId, name, output] of [
      ['c1', 'maestrly_overview', '{"needsYou":[]}'],
      ['c2', 'ask_assistant', '{"error":"The message was not sent."}'],
    ]) {
      activity = voiceActivityFromCall(activity, { callId, name, args: {}, done: false }, 0)
      activity = voiceActivityFromCall(activity, { callId, name, args: {}, done: true, output }, 1)
    }
    expect(summary(activity)).toEqual(['maestrly_overview:done', 'ask_assistant:failed'])
  })

  it('lets a request that waited go on once the card is answered on the screen', () => {
    let activity = voiceActivityFromCall(
      EMPTY_VOICE_ACTIVITY,
      { callId: 'c', name: 'ask_assistant', args: {}, done: false },
      0
    )
    activity = voiceActivityFromCall(
      activity,
      { callId: 'c', name: 'ask_assistant', args: {}, done: true, output: '{"confirmOnCard":"Aprovar?"}' },
      1
    )
    expect(summary(questionsSettled(activity, 2))).toEqual(['ask_assistant:done'])
  })

  it('starts over with each request but keeps what still runs, and a call’s summary counts only its own work', () => {
    let activity = chat(
      EMPTY_VOICE_ACTIVITY,
      { kind: 'tool-call', messageId: 'm', toolCallId: 'a', toolName: 'bash', input: {} },
      { kind: 'tool-call', messageId: 'm', toolCallId: 'b', toolName: 'bash', input: {} },
      { kind: 'tool-state', messageId: 'm', toolCallId: 'a', state: { status: 'completed', output: '' } }
    )
    activity = newVoiceTurn(activity)
    expect(activity.items.map((item) => item.id)).toEqual(['b'])
    expect(activity.done).toHaveLength(1)
    expect(startVoiceCall(activity).done).toEqual([])
  })

  it('stops the voice’s own calls when the call ends, not the assistant’s', () => {
    let activity = voiceActivityFromCall(
      EMPTY_VOICE_ACTIVITY,
      { callId: 'v', name: 'ask_assistant', args: {}, done: false },
      0
    )
    activity = chat(activity, { kind: 'tool-call', messageId: 'm', toolCallId: 'a', toolName: 'bash', input: {} })
    expect(summary(endVoiceCall(activity, 5))).toEqual(['ask_assistant:cancelled', 'bash:running'])
  })
})
