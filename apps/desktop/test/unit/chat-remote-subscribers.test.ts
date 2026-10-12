import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeChatHost } from '../../src/main/chat/host-events'
import {
  clearAllChatSubscriptions,
  sendChatEvent,
  subscribeChatStream,
  unsubscribeChatStream,
} from '../../src/main/chat/stream-subscribers'
import { registerRemoteUiTarget } from '../../src/main/remote-ui-targets'

function renderer(id = 1) {
  return { id, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), removeListener: vi.fn() }
}
const cleanup: Array<() => void> = []
function remoteRenderer(id: number) {
  const remote = renderer(id)
  cleanup.push(registerRemoteUiTarget(remote, { role: 'main' }))
  return remote
}
afterEach(() => {
  clearAllChatSubscriptions()
  for (const off of cleanup.splice(0)) off()
})

describe('chat events for remote subscribers', () => {
  it("reaches every remote subscriber of the conversation, not only the turn's renderer", () => {
    const local = renderer()
    const remote = remoteRenderer(-1001)
    const elsewhere = remoteRenderer(-1002)
    subscribeChatStream(local as never, 'c')
    subscribeChatStream(remote as never, 'c')
    subscribeChatStream(elsewhere as never, 'other')

    sendChatEvent(local as never, 'chat:delta:c', { kind: 'text' })
    expect(local.send).toHaveBeenCalledWith('chat:delta:c', { kind: 'text' })
    expect(remote.send).toHaveBeenCalledWith('chat:delta:c', { kind: 'text' })
    expect(elsewhere.send).not.toHaveBeenCalled()

    sendChatEvent(local as never, 'chat:permission:c', { kind: 'asked' })
    expect(remote.send).toHaveBeenCalledWith('chat:permission:c', { kind: 'asked' })
  })

  it('reaches remote subscribers when the turn was started by the host itself or by another computer', () => {
    // A plan, a review or a dispatch starts a turn with the host's own hidden window, which subscribes to nothing.
    const hostWindow = renderer()
    const remote = remoteRenderer(-1003)
    subscribeChatStream(remote as never, 'c')

    sendChatEvent(hostWindow as never, 'chat:delta:c', { kind: 'text' })
    expect(hostWindow.send).not.toHaveBeenCalled()
    expect(remote.send).toHaveBeenCalledWith('chat:delta:c', { kind: 'text' })
  })

  it('sends conversation channels outside the subscription gate to remote subscribers too', () => {
    const local = renderer()
    const remote = remoteRenderer(-1004)
    const unsubscribed = remoteRenderer(-1005)
    subscribeChatStream(remote as never, 'c')

    for (const channel of ['chat:maestro-live:c', 'chat:subscription-failover:c']) {
      sendChatEvent(local as never, channel, 1)
      // As before, this computer's renderer receives these without subscribing.
      expect(local.send).toHaveBeenCalledWith(channel, 1)
      expect(remote.send).toHaveBeenCalledWith(channel, 1)
    }
    expect(unsubscribed.send).not.toHaveBeenCalled()
  })

  it('sends once to a remote renderer that also started the turn', () => {
    const remote = remoteRenderer(-1006)
    subscribeChatStream(remote as never, 'c')
    sendChatEvent(remote as never, 'chat:delta:c', 1)
    expect(remote.send).toHaveBeenCalledTimes(1)
  })

  it('stops after the last unsubscribe of a renderer that subscribed twice', () => {
    const local = renderer()
    const remote = remoteRenderer(-1007)
    subscribeChatStream(remote as never, 'c')
    subscribeChatStream(remote as never, 'c')
    unsubscribeChatStream(remote as never, 'c')
    sendChatEvent(local as never, 'chat:delta:c', 1)
    expect(remote.send).toHaveBeenCalledTimes(1)
    unsubscribeChatStream(remote as never, 'c')
    sendChatEvent(local as never, 'chat:delta:c', 2)
    expect(remote.send).toHaveBeenCalledTimes(1)
  })

  it('behaves as before with no remote subscriber', () => {
    const local = renderer()
    const other = renderer(2)
    subscribeChatStream(other as never, 'c')
    const observed: string[] = []
    const stop = observeChatHost('c', (event) => observed.push(event.channel))

    sendChatEvent(local as never, 'chat:delta:c', 1)
    expect(local.send).not.toHaveBeenCalled()
    // Another renderer of this computer keeps receiving only the turns it started.
    expect(other.send).not.toHaveBeenCalled()
    sendChatEvent(local as never, 'chat:maestro-live:c', 2)
    expect(local.send).toHaveBeenCalledWith('chat:maestro-live:c', 2)
    sendChatEvent(local as never, 'chat:unscoped', 3)
    expect(local.send).toHaveBeenCalledWith('chat:unscoped', 3)
    // Backend observers hear gated stream events once, whoever is subscribed.
    expect(observed).toEqual(['chat:delta:c'])
    stop()
  })
})
