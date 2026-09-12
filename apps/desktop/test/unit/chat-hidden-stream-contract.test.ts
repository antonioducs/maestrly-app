import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatView = readFileSync(new URL('../../src/renderer/components/chat/ChatView.tsx', import.meta.url), 'utf8')

describe('ChatView streams for hidden conversations', () => {
  const streamEffect = chatView.slice(
    chatView.indexOf('const offStream = window.api.onChatStream'),
    chatView.indexOf(
      '  useEffect(() => {\n    Promise.all([window.api.chatGetSelection',
      chatView.indexOf('const offStream = window.api.onChatStream')
    )
  )

  it('skips hidden React deltas while preserving completion and queues', () => {
    const foldIndex = streamEffect.indexOf('applyChatEvent(prev, event)')
    const hiddenReturnIndex = streamEffect.indexOf('if (hidden) return')

    expect(streamEffect).toContain('const hidden = !visibleRef.current')
    expect(streamEffect).toContain('finishTurn(hidden)')
    expect(hiddenReturnIndex).toBeGreaterThan(-1)
    expect(foldIndex).toBeGreaterThan(hiddenReturnIndex)
    // Always normalize folded history and protect the active message anchor.
    expect(streamEffect).toContain(
      "normalizeHistoryWindow(prev, applyChatEvent(prev, event), 'replace', event.messageId)"
    )
    expect(chatView).toContain('const [head, ...rest] = q')
    expect(chatView).toContain('setQueueState(rest)')
    expect(streamEffect).toContain('finishTurn(hidden)')
    expect(chatView).toContain("const resolved = typeof next === 'function' ? next(queueRef.current) : next")
    expect(chatView).toContain('queueRef.current = resolved')
  })

  it('updates eviction safety when hidden queues advance or cancel', () => {
    const finishStart = chatView.indexOf('const finishTurn = useCallback')
    const finishEnd = chatView.indexOf('const needsLiveSubscription =', finishStart)
    expect(finishStart).toBeGreaterThan(-1)
    expect(finishEnd).toBeGreaterThan(finishStart)
    const finishTurn = chatView.slice(finishStart, finishEnd)

    expect(finishTurn).toContain('setQueueState([])')
    expect(finishTurn).toContain('setQueueState(rest)')
    expect(finishTurn).not.toContain('if (!hidden) setQueueState(rest)')
    expect(finishTurn).not.toContain('if (!hidden) setQueueState([])')
  })

  it('clears saved flags and resolved permissions offscreen', () => {
    const savedIndex = streamEffect.indexOf("if (kind === 'user-saved')")
    const savedSegment = streamEffect.slice(savedIndex, streamEffect.indexOf('return', savedIndex) + 'return'.length)

    expect(savedIndex).toBeGreaterThan(-1)
    expect(savedSegment).toContain('slashSentRef.current = false')
    expect(savedSegment).toContain('agentMentionsSentRef.current = false')
    expect(streamEffect).toContain('const next = prev.filter((r) => r.id !== ev.requestId)')
    expect(streamEffect).toContain('return next.length === prev.length ? prev : next')
  })

  it('drops unnecessary hidden subscriptions and reconciles visible runtimes', () => {
    expect(chatView).toContain('const needsLiveSubscription =')
    expect(chatView).toContain('queue.length > 0 ||')
    expect(chatView).toContain('pending.length > 0 ||')
    expect(chatView).toContain('stopPending ||')
    expect(chatView).toContain('maestroPostPending > 0 ||')
    expect(chatView).toContain('if (!needsLiveSubscription) return')
    expect(chatView).not.toContain('if (!runtime.streaming) stoppedRef.current = false')
    expect(chatView).not.toContain('historyDirtyRef')
  })

  it('reloads on visibility and rejects stale snapshots', () => {
    const reloadStart = chatView.indexOf('const reloadLatestPage = useCallback')
    const reloadEnd = chatView.indexOf('const loadOlder', reloadStart)
    const reload = chatView.slice(reloadStart, reloadEnd)
    const visibleStart = chatView.indexOf(
      '  useEffect(() => {\n    if (!visible) return',
      chatView.indexOf('const offStream = window.api.onChatStream')
    )
    const visibleEnd = chatView.indexOf(
      '  useEffect(() => {\n    Promise.all([window.api.chatGetSelection',
      visibleStart
    )
    expect(reloadStart).toBeGreaterThan(-1)
    expect(reloadEnd).toBeGreaterThan(reloadStart)
    expect(visibleStart).toBeGreaterThan(-1)
    expect(visibleEnd).toBeGreaterThan(visibleStart)
    const visibleEffect = chatView.slice(visibleStart, visibleEnd)

    expect(chatView).toContain('const historyReloadRevisionRef = useRef(0)')
    expect(reload).toContain('const revision = ++historyReloadRevisionRef.current')
    expect(reload).toContain('revision !== historyReloadRevisionRef.current')
    expect(visibleEffect).toContain('void reloadLatestPage()')
    expect(visibleEffect).not.toContain('if (historyDirtyRef.current) void reloadLatestPage()')
  })

  it('consumes stop completion without advancing the queue', () => {
    const finishStart = chatView.indexOf('const finishTurn = useCallback')
    const finishEnd = chatView.indexOf('const needsLiveSubscription =', finishStart)
    expect(finishStart).toBeGreaterThan(-1)
    expect(finishEnd).toBeGreaterThan(finishStart)
    const finishTurn = chatView.slice(finishStart, finishEnd)
    const stoppedStart = finishTurn.indexOf('if (stoppedRef.current)')
    const stoppedEnd = finishTurn.indexOf('const q = queueRef.current', stoppedStart)
    const stoppedBranch = finishTurn.slice(stoppedStart, stoppedEnd)
    const stopStart = chatView.indexOf('const stop = useCallback')
    const stopEnd = chatView.indexOf('const decide = useCallback', stopStart)
    const stop = chatView.slice(stopStart, stopEnd)

    expect(chatView).toContain('const [stopPending, setStopPending] = useState(false)')
    expect(stop).toContain('stoppedRef.current = true')
    expect(stop).toContain('setStopPending(true)')
    expect(stop).toContain('setQueueState([])')
    expect(finishTurn).toContain('if (stoppedRef.current)')
    expect(finishTurn).toContain('setStopPending(false)')
    expect(finishTurn).toContain('setQueueState([])')
    expect(stoppedBranch).not.toContain('doSend(head.text, head.attachments, head.agentMentions')

    const stopPendingIndex = chatView.indexOf('setStopPending(true)')
    const subscriptionGateIndex = chatView.indexOf('const needsLiveSubscription =')
    const doneIndex = chatView.indexOf("if (kind === 'done')")
    const clearIndex = finishTurn.indexOf('setStopPending(false)')
    expect(stopPendingIndex).toBeGreaterThan(stopStart)
    expect(subscriptionGateIndex).toBeGreaterThan(0)
    expect(doneIndex).toBeGreaterThan(subscriptionGateIndex)
    expect(clearIndex).toBeGreaterThan(-1)
  })
})
