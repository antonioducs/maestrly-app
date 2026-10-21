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
import { FleetFileQuotaError } from '../../src/main/fleet/instance/files'
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
  expect(mocks.publish).toHaveBeenCalledWith('a.pdf', 'download.pdf', 'own-conversation')
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
it('says which limit refused a shared file and how much space is left', async () => {
  const usage = {
    usedBytes: 1073741824 - 6 * 1024 ** 2,
    count: 36,
    quotaBytes: 1073741824,
    countMax: 200,
    deleteWithConversations: true,
    updatedAt: null,
  }
  mocks.publish.mockRejectedValueOnce(new FleetFileQuotaError('space', 8.2 * 1024 ** 2, usage))
  const space = await invoke({ path: 'a.pdf' })
  expect(space.isError).toBe(true)
  expect(space.content[0]!.text).toContain('8.2 MiB')
  expect(space.content[0]!.text).toContain('6.0 MiB')
  expect(space.content[0]!.text).toContain('1.0 GiB')
  expect(space.content[0]!.text).toContain('Files')
  expect(space.content[0]!.text).not.toContain('/private')

  mocks.publish.mockRejectedValueOnce(new FleetFileQuotaError('count', 0, usage))
  const count = await invoke({ path: 'a.pdf' })
  expect(count.isError).toBe(true)
  expect(count.content[0]!.text).toContain('200 shared files')
  expect(count.content[0]!.text).not.toContain('/private')

  mocks.publish.mockRejectedValueOnce(new FleetFileQuotaError('size', 120 * 1024 ** 2, usage))
  const size = await invoke({ path: 'a.pdf' })
  expect(size.isError).toBe(true)
  expect(size.content[0]!.text).toContain('120.0 MiB')
  expect(size.content[0]!.text).toContain('100 MiB')
  expect(size.content[0]!.text).not.toContain('/private')
})
