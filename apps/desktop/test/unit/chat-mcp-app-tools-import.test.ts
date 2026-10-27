import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The registry's last import. Holding it keeps the registry half evaluated, as a slow disk or a busy machine does for
// the first turn of a conversation.
const gate = vi.hoisted(() => {
  let open!: () => void
  let reached!: () => void
  return {
    opened: new Promise<void>((resolve) => (open = resolve)),
    open: () => open(),
    entered: new Promise<void>((resolve) => (reached = resolve)),
    enter: () => reached(),
  }
})
vi.mock('../../src/main/chat/generated-interfaces', async (importOriginal) => {
  gate.enter()
  await gate.opened
  return importOriginal<typeof import('../../src/main/chat/generated-interfaces')>()
})

import { buildAppTools } from '../../src/main/chat/mcp'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'

describe('buildAppTools', () => {
  let convId: string

  beforeEach(() => {
    freshDb()
    convId = makeConversation(makeWorkspace().id).id
  })
  afterEach(closeDb)

  // The registry reaches chat/mcp again through the fleet instance, so a test runner treats it as a circular import
  // and hands a second `import()` the half-evaluated module: its tools then ran against imports not yet bound
  // ("Cannot access ... before initialization"). A turn that starts while an earlier one is still loading the
  // registry must wait for it instead.
  it('builds the tools of a turn that starts while the registry loads', { timeout: 60_000 }, async () => {
    const args = { conversationId: convId, mode: 'agent', gate: async () => {} } as const
    const first = buildAppTools(args)
    await gate.entered
    const second = buildAppTools(args)
    // Let the second turn run against the module as it is now.
    await new Promise((resolve) => setTimeout(resolve, 50))
    gate.open()

    const built = await Promise.allSettled([first, second])
    const failures = built.flatMap((entry) => (entry.status === 'rejected' ? [String(entry.reason)] : []))
    for (const entry of built) if (entry.status === 'fulfilled') await entry.value.close()
    expect(failures).toEqual([])
    for (const entry of built) {
      expect(entry.status === 'fulfilled' && Object.keys(entry.value.tools)).toContain('terminal_run')
    }
  })
})
