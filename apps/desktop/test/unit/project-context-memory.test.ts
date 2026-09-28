import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { buildProjectContext } from '../../src/main/chat/project-context'
import { saveConversationMemoryState } from '../../src/main/store/conversation-memory-state'
import {
  BOT_MEMORY_SPACE_ID,
  clearConversationMemorySpace,
  registerConversationMemorySpace,
} from '../../src/main/memory/spaces'

beforeEach(freshDb)
afterEach(closeDb)

describe('project context with memory core', () => {
  it('appends the frozen core for the conversation, also without a project', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    saveConversationMemoryState({
      conversationId: conversation.id,
      spaceId: workspace.id,
      coreEpoch: '',
      coreText: '---\n# Memory\nCORE',
      baseline: [],
      recallEpoch: '',
      recalledIds: [],
      updatedAt: 1,
    })
    expect(await buildProjectContext(workspace.id, conversation.cwd, conversation.id)).toContain('# Memory\nCORE')
    expect(await buildProjectContext(workspace.id, conversation.cwd)).not.toContain('CORE')
    registerConversationMemorySpace(conversation.id, { id: BOT_MEMORY_SPACE_ID, kind: 'bot' })
    saveConversationMemoryState({
      conversationId: conversation.id,
      spaceId: BOT_MEMORY_SPACE_ID,
      coreEpoch: '',
      coreText: '---\n# Memory\nBOT',
      baseline: [],
      recallEpoch: '',
      recalledIds: [],
      updatedAt: 2,
    })
    expect(await buildProjectContext(null, conversation.cwd, conversation.id)).toBe('\n\n---\n# Memory\nBOT')
    clearConversationMemorySpace(conversation.id)
  })
})
