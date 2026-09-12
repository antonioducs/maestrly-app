import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Database and artifact ownership: resolve parts by conversation, message and part IDs,
 * chat:generated-image uses, never a renderer path) and (b) delete files when their owning messages
 * references disappear; otherwise artifacts remain orphaned forever.
 */
const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    getName: () => 'agents-test',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en-US',
    getAppPath: () => h.userData,
    isPackaged: false,
    on: () => {},
    once: () => {},
  },
}))

const { freshDb, closeDb } = await import('../helpers/db')
const { makeConversation, makeWorkspace } = await import('../helpers/factories')
const {
  clearChatMessages,
  deleteChatMessage,
  deleteChatMessagesFrom,
  findGeneratedImagePart,
  getMessageSeq,
  upsertChatMessage,
} = await import('../../src/main/chat/chat-store')
const { saveGeneratedImage } = await import('../../src/main/chat/generated-images')

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const artifactFile = (conversationId: string, artifactId: string): string =>
  path.join(h.userData, 'chat-generated-images', conversationId, `${artifactId}.png`)

beforeEach(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-genimg-store-'))
  freshDb()
})
afterEach(() => {
  closeDb()
  rmSync(h.userData, { recursive: true, force: true })
})

function chatConv(): { id: string } {
  const ws = makeWorkspace()
  return makeConversation(ws.id, { mode: 'local' })
}

/** Write both artifacts and referencing messages to preserve ownership consistency. */
async function addImageMessage(
  conversationId: string,
  messageId: string,
  createdAt = 1
): Promise<{ artifactId: string }> {
  const stored = await saveGeneratedImage({ conversationId, result: PNG_1X1 })
  upsertChatMessage({
    id: messageId,
    conversationId,
    role: 'assistant',
    createdAt,
    parts: [
      {
        type: 'generated-image',
        id: `${messageId}_img`,
        artifactId: stored.artifactId,
        name: stored.name,
        mediaType: stored.mediaType,
        byteSize: stored.byteSize,
      },
    ],
  })
  return { artifactId: stored.artifactId }
}

describe('findGeneratedImagePart', () => {
  it('resolves the correct message part', async () => {
    const conv = chatConv()
    const { artifactId } = await addImageMessage(conv.id, 'm1')

    expect(findGeneratedImagePart(conv.id, 'm1', 'm1_img')).toMatchObject({ type: 'generated-image', artifactId })
  })

  it('rejects messages owned by other conversations', async () => {
    const conv = chatConv()
    const other = chatConv()
    await addImageMessage(conv.id, 'm1')

    expect(findGeneratedImagePart(other.id, 'm1', 'm1_img')).toBeNull()
  })

  it('rejects missing messages and parts', async () => {
    const conv = chatConv()
    await addImageMessage(conv.id, 'm1')

    expect(findGeneratedImagePart(conv.id, 'nope', 'm1_img')).toBeNull()
    expect(findGeneratedImagePart(conv.id, 'm1', 'nope')).toBeNull()
  })
})

describe('artifact cleanup during message deletion', () => {
  it('deletes files owned by deleted messages', async () => {
    const conv = chatConv()
    const first = await addImageMessage(conv.id, 'm1', 1)
    const second = await addImageMessage(conv.id, 'm2', 2)

    deleteChatMessage('m1')
    await vi.waitFor(() => expect(existsSync(artifactFile(conv.id, first.artifactId))).toBe(false))
    expect(existsSync(artifactFile(conv.id, second.artifactId))).toBe(true)
  })

  it('deletes only truncated artifacts', async () => {
    const conv = chatConv()
    const kept = await addImageMessage(conv.id, 'm1', 1)
    const dropped = await addImageMessage(conv.id, 'm2', 2)

    const seq = getMessageSeq('m2')
    if (seq == null) throw new Error('missing seq')
    deleteChatMessagesFrom(conv.id, seq)

    await vi.waitFor(() => expect(existsSync(artifactFile(conv.id, dropped.artifactId))).toBe(false))
    expect(existsSync(artifactFile(conv.id, kept.artifactId))).toBe(true)
  })

  it('clears only conversation-owned artifacts', async () => {
    const conv = chatConv()
    const other = chatConv()
    const mine = await addImageMessage(conv.id, 'm1', 1)
    const theirs = await addImageMessage(other.id, 'm2', 2)

    // Await removal before chat:clear releases reservations.
    await clearChatMessages(conv.id)

    expect(existsSync(artifactFile(conv.id, mine.artifactId))).toBe(false)
    expect(existsSync(artifactFile(other.id, theirs.artifactId))).toBe(true)
  })
})
