import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from '../../src/shared/chat'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))
import { savePdfAttachment } from '../../src/main/chat/attachment-artifacts'
import { readConversationFile } from '../../src/main/fleet/instance/attachment-files'
import { imageId } from '../../src/main/fleet/instance/images'
import { projectChatMessages } from '../../src/main/fleet/instance/transcript'

beforeEach(async () => {
  state.userData = await mkdtemp(path.join(os.tmpdir(), 'fleet-attachment-read-'))
})
afterEach(async () => {
  await rm(state.userData, { recursive: true, force: true })
})

it('downloads original PDF and exact UTF-8 text from this conversation only', async () => {
  const pdf = Buffer.from('%PDF-1.7\nsynthetic bytes')
  const stored = await savePdfAttachment({ conversationId: 'bot-chat', bytes: pdf, label: 'report.pdf' })
  const text = '\uFEFFOlá 世界\r\n'
  const message: ChatMessage = {
    id: 'm',
    conversationId: 'bot-chat',
    role: 'user',
    createdAt: Date.now(),
    parts: [
      {
        type: 'file',
        id: 'pdf',
        name: 'report.pdf',
        mediaType: 'application/pdf',
        kind: 'pdf',
        artifactId: stored.artifactId,
        byteSize: pdf.length,
        data: 'extracted text is not the download',
      },
      { type: 'file', id: 'text', name: 'notes.txt', mediaType: 'text/plain', kind: 'text', data: text },
    ],
  }
  const pdfId = imageId('a', 'm', 'pdf')
  const textId = imageId('a', 'm', 'text')
  expect((await readConversationFile('bot-chat', pdfId, [message]))?.bytes).toEqual(pdf)
  expect((await readConversationFile('bot-chat', textId, [message]))?.bytes).toEqual(Buffer.from(text))
  expect(await readConversationFile('another-bot', pdfId, [message])).toBeNull()
  expect(await readConversationFile('bot-chat', imageId('a', 'm', 'unknown'), [message])).toBeNull()
  expect(await readConversationFile('bot-chat', pdfId, [{ ...message, role: 'assistant' }])).toBeNull()
})

it('projects complete published metadata before shortening tool output and excludes unsuccessful publications', () => {
  const file = { id: 'f-result', name: 'a'.repeat(196) + '.pdf', mediaType: 'application/pdf', byteSize: 42 }
  const message: ChatMessage = {
    id: 'm',
    conversationId: 'bot-chat',
    role: 'assistant',
    createdAt: Date.now(),
    parts: [
      {
        type: 'tool',
        id: 'p',
        toolCallId: 'call',
        toolName: 'bot_share_file',
        input: { path: 'report.pdf' },
        state: { status: 'completed', output: JSON.stringify({ file, detail: 'Long result '.repeat(100) }) },
      },
    ],
  }
  expect(projectChatMessages([message])[0]).toMatchObject({ files: [file] })
  const part = message.parts[0]
  if (part.type !== 'tool') throw new Error('Expected tool')
  part.state = { status: 'error', error: JSON.stringify({ file }) }
  expect(projectChatMessages([message])[0]).not.toHaveProperty('files')
  part.state = { status: 'completed', output: JSON.stringify({ file: { ...file, id: '../../secret' } }) }
  expect(projectChatMessages([message])[0]).not.toHaveProperty('files')
})
