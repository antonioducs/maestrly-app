import { describe, expect, it } from 'vitest'

import { QuestionBroker } from '../../src/main/chat/question-broker'
import type { ChatQuestion } from '../../src/shared/chat'

const questions: ChatQuestion[] = [
  { header: 'Framework', question: 'Qual framework?', options: [{ label: 'React' }, { label: 'Vue' }] },
]

function askInput(conversationId: string, toolCallId: string, signal?: AbortSignal) {
  return { conversationId, messageId: `message-${conversationId}`, toolCallId, questions, signal }
}

describe('QuestionBroker', () => {
  it('blocks in ask() and resolves with reply() answers', async () => {
    const broker = new QuestionBroker()
    const pending = broker.ask(askInput('c1', 'call-1'))

    expect(broker.pendingFor('c1')).toEqual(['call-1'])

    broker.reply('call-1', [['React'], ['Yes', 'Maybe']])

    await expect(pending).resolves.toEqual([['React'], ['Yes', 'Maybe']])
    expect(broker.pendingFor('c1')).toEqual([]) // cleared the pending question after resolving
  })

  it('projects messageId and questions while pending and clears them on reply', async () => {
    const broker = new QuestionBroker()
    const pending = broker.ask(askInput('c1', 'call-1'))

    expect(broker.pendingQuestionsFor('c1')).toEqual([{ messageId: 'message-c1', toolCallId: 'call-1', questions }])

    broker.reply('call-1', [['React']])
    await pending
    expect(broker.pendingQuestionsFor('c1')).toEqual([])
  })

  it('reply() is a no-op for unknown toolCallId without throwing', () => {
    const broker = new QuestionBroker()
    expect(() => broker.reply('fantasma', [['x']])).not.toThrow()
  })

  it('reply() with non-array answers becomes [] (dismissed)', async () => {
    const broker = new QuestionBroker()
    const pending = broker.ask(askInput('c1', 'call-1'))
    // @ts-expect-error — exercise the runtime guard against invalid IPC payloads
    broker.reply('call-1', null)
    await expect(pending).resolves.toEqual([])
  })

  it('rejectConversation() dismisses only pending questions from the target conversation', async () => {
    const broker = new QuestionBroker()
    const a = broker.ask(askInput('c1', 'a'))
    const b = broker.ask(askInput('c1', 'b'))
    const other = broker.ask(askInput('c2', 'z'))

    broker.rejectConversation('c1')

    await expect(a).resolves.toEqual([])
    await expect(b).resolves.toEqual([])
    expect(broker.pendingFor('c1')).toEqual([])
    expect(broker.pendingFor('c2')).toEqual(['z']) // intacto

    broker.reply('z', [['ok']])
    await expect(other).resolves.toEqual([['ok']])
  })

  it('emits "asked" on ask() and "answered" on reply() to drive asking↔working status', async () => {
    const broker = new QuestionBroker()
    const events: string[] = []
    broker.on('asked', ({ conversationId }: { conversationId: string }) => events.push(`asked:${conversationId}`))
    broker.on('answered', ({ conversationId }: { conversationId: string }) => events.push(`answered:${conversationId}`))

    const pending = broker.ask(askInput('c1', 'call-1'))
    broker.reply('call-1', [['ok']])
    await pending

    expect(events).toEqual(['asked:c1', 'answered:c1'])
  })

  it('rejectConversation does not emit "answered" because abort/teardown handles status', async () => {
    const broker = new QuestionBroker()
    const events: string[] = []
    broker.on('answered', () => events.push('answered'))
    const pending = broker.ask(askInput('c1', 'call-1'))
    broker.rejectConversation('c1')
    await pending
    expect(events).toEqual([])
  })

  it('isolates concurrent questions by toolCallId', async () => {
    const broker = new QuestionBroker()
    const first = broker.ask(askInput('c1', 'first'))
    const second = broker.ask(askInput('c1', 'second'))

    broker.reply('second', [['B']])
    broker.reply('first', [['A']])

    await expect(first).resolves.toEqual([['A']])
    await expect(second).resolves.toEqual([['B']])
  })

  it('abort dismisses exactly the signaled question and emits answered to clear state', async () => {
    const broker = new QuestionBroker()
    const firstController = new AbortController()
    const answered: string[] = []
    broker.on('answered', ({ toolCallId }: { toolCallId: string }) => answered.push(toolCallId))
    const first = broker.ask(askInput('c1', 'first', firstController.signal))
    const second = broker.ask(askInput('c1', 'second'))

    firstController.abort()

    await expect(first).resolves.toEqual([])
    expect(broker.pendingFor('c1')).toEqual(['second'])
    expect(answered).toEqual(['first'])

    broker.reply('second', [['continua']])
    await expect(second).resolves.toEqual([['continua']])
  })
})
