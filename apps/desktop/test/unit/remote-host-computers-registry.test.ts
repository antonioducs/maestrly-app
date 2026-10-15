import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ serverMode: { value: true } }))
vi.mock('../../src/main/remote-host/server/config', () => ({ isServerMode: () => h.serverMode.value }))
vi.mock('../../src/main/store', () => ({ getConversation: (id: string) => (id.startsWith('conv') ? { id } : null) }))

import type { ConversationComputers } from '../../src/main/remote-host/server/computers'
import { openComputerForViewer, setServerComputers } from '../../src/main/remote-host/server/computers-registry'
import { registerRemoteUiTarget } from '../../src/main/remote-ui-targets'

afterEach(() => {
  setServerComputers(null)
  h.serverMode.value = true
})

describe("opening a conversation's computer for its Computer tab", () => {
  it("opens it for the owner, from another computer's window only", async () => {
    const open = vi.fn(async () => ({ ok: true as const, display: ':10', started: true }))
    setServerComputers({ open } as unknown as ConversationComputers)
    const viewer = { id: -1 }
    const unregister = registerRemoteUiTarget(viewer as never, {} as never)
    try {
      await expect(openComputerForViewer({ id: 1 }, 'conv-1')).rejects.toThrow(/remote viewers/)
      h.serverMode.value = false
      await expect(openComputerForViewer(viewer, 'conv-1')).rejects.toThrow(/remote viewers/)
      h.serverMode.value = true
      for (const id of ['', 'other', 7, 'conv-' + 'x'.repeat(200)])
        await expect(openComputerForViewer(viewer, id)).rejects.toThrow(/Unknown conversation/)
      expect(open).not.toHaveBeenCalled()

      expect(await openComputerForViewer(viewer, 'conv-1')).toEqual({ ok: true, display: ':10', started: true })
      expect(open).toHaveBeenCalledWith('conv-1', 'owner')
      // A host without what computers need answers so, instead of failing.
      setServerComputers(null)
      expect(await openComputerForViewer(viewer, 'conv-1')).toEqual({ ok: false, reason: 'unavailable' })
    } finally {
      unregister()
    }
  })
})
