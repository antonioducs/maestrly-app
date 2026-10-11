import { beforeEach, expect, it, vi } from 'vitest'
import type { McpToolContext } from '../../src/main/mcp/tools/context'

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  conversation: vi.fn(),
  scope: vi.fn(),
  resolve: vi.fn(),
  publish: vi.fn(),
}))
vi.mock('../../src/main/fleet/instance', () => ({ botRuntimeForConversation: mocks.runtime }))
vi.mock('../../src/main/store/conversations', () => ({ getConversation: mocks.conversation }))
vi.mock('../../src/main/conversation-file-scope', () => ({ createConversationFileScope: mocks.scope }))
import { registerBotFileTools } from '../../src/main/mcp/tools/bot-files'

let invoke: (args: { path: string; name?: string }) => Promise<{ content: { text: string }[]; isError?: boolean }>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.runtime.mockReturnValue({ publishFile: mocks.publish })
  mocks.conversation.mockReturnValue({ id: 'own-conversation' })
  mocks.scope.mockResolvedValue({ resolveBridgePath: mocks.resolve })
  mocks.resolve.mockResolvedValue({ root: '/private/files', target: '/private/files/a.pdf' })
  mocks.publish.mockResolvedValue({ id: 'f-synthetic', name: 'a.pdf', mediaType: 'application/pdf', byteSize: 4 })
  registerBotFileTools({
    convId: 'own-conversation',
    server: {
      registerTool: (_name: string, _options: unknown, handler: typeof invoke) => {
        invoke = handler
      },
    },
  } as unknown as McpToolContext)
})
it('resolves only the current conversation and returns a reference without paths or credentials', async () => {
  const result = await invoke({ path: 'a.pdf', name: 'download.pdf' })
  expect(mocks.runtime).toHaveBeenCalledWith('own-conversation')
  expect(mocks.scope).toHaveBeenCalledWith({ id: 'own-conversation' })
  expect(mocks.resolve).toHaveBeenCalledWith('a.pdf')
  expect(mocks.publish).toHaveBeenCalledWith('a.pdf', 'download.pdf')
  expect(JSON.parse(result.content[0]!.text)).toEqual({ file: await mocks.publish.mock.results[0]!.value })
  expect(result.content[0]!.text).not.toContain('/private')
})
it('denies a conversation without its own runtime', async () => {
  mocks.runtime.mockReturnValue(null)
  expect((await invoke({ path: 'a.pdf' })).isError).toBe(true)
  expect(mocks.publish).not.toHaveBeenCalled()
})
it.each(['/etc/passwd', 'C:\\private\\file', '\0file'])('rejects nonrelative path %s', async (value) => {
  expect((await invoke({ path: value })).isError).toBe(true)
  expect(mocks.publish).not.toHaveBeenCalled()
})
it('preserves scope rejection and hides internal error details', async () => {
  mocks.resolve.mockRejectedValueOnce(new Error('private-token /private/path'))
  const result = await invoke({ path: '../secret' })
  expect(result.isError).toBe(true)
  expect(result.content[0]!.text).not.toContain('private-token')
  expect(mocks.publish).not.toHaveBeenCalled()
})
