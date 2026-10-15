import { afterEach, describe, expect, it } from 'vitest'
import { remoteConversationLabel, setRemoteConversationLabels } from '../../src/main/remote-conversation-labels'

const A = 'server-1/workspaces#a'
const B = 'server-1/workspaces#b'

afterEach(() => {
  setRemoteConversationLabels([])
})

describe("remote hosts' conversation labels", () => {
  it('keeps the name and project of each remote conversation the window lists', () => {
    expect(
      setRemoteConversationLabels([
        { id: A, name: 'Fix login', projectName: 'api' },
        { id: B, name: 'Chat' },
      ])
    ).toEqual([A, B])
    expect(remoteConversationLabel(A)).toEqual({ name: 'Fix login', projectName: 'api' })
    expect(remoteConversationLabel(B)).toEqual({ name: 'Chat' })
    expect(remoteConversationLabel('server-1/workspaces#c')).toBeNull()
  })

  it('reports renamed, moved and removed conversations only', () => {
    setRemoteConversationLabels([
      { id: A, name: 'A', projectName: 'api' },
      { id: B, name: 'B' },
    ])
    expect(
      setRemoteConversationLabels([
        { id: A, name: 'A', projectName: 'api' },
        { id: B, name: 'B' },
      ])
    ).toEqual([])
    expect(setRemoteConversationLabels([{ id: A, name: 'A', projectName: 'web' }])).toEqual([A, B])
    expect(remoteConversationLabel(B)).toBeNull()
  })

  it("ignores this computer's conversations, malformed entries and lists that are not lists", () => {
    setRemoteConversationLabels([{ id: A, name: 'A' }])
    expect(setRemoteConversationLabels('nope')).toEqual([])
    expect(remoteConversationLabel(A)).toEqual({ name: 'A' })
    setRemoteConversationLabels([{ id: 'local-conv', name: 'Local' }, null, { id: 7, name: 'x' }, { id: B, name: 3 }])
    expect(remoteConversationLabel('local-conv')).toBeNull()
    expect(remoteConversationLabel(B)).toEqual({ name: '' })
    setRemoteConversationLabels([{ id: A, name: 'x'.repeat(1000), projectName: 'p'.repeat(1000) }])
    expect(remoteConversationLabel(A)?.name).toHaveLength(300)
    expect(remoteConversationLabel(A)?.projectName).toHaveLength(300)
  })
})
