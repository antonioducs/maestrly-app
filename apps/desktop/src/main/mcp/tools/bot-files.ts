import path from 'node:path'
import { z } from 'zod'
import { createConversationFileScope } from '../../conversation-file-scope'
import { botRuntimeForConversation } from '../../fleet/instance'
import { getConversation } from '../../store/conversations'
import { err, ok, type McpToolContext } from './context'

export function registerBotFileTools(ctx: McpToolContext): void {
  ctx.server.registerTool(
    'bot_share_file',
    {
      description:
        'Share a file from your conversation files directory privately with your owner. Give a relative path and an optional download name. A snapshot is retained even if you edit the source later. The returned file reference is automatically shown as a download card; do not invent a download URL.',
      inputSchema: {
        path: z.string().min(1).max(4096).describe('Relative path in this conversation files directory.'),
        name: z.string().trim().min(1).max(200).optional().describe('Optional display name for the download.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ path: relativePath, name }) => {
      try {
        const bot = botRuntimeForConversation(ctx.convId)
        const conversation = getConversation(ctx.convId)
        if (!bot || !conversation) return err('File sharing is available only in this bot’s own conversation.')
        if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || relativePath.includes('\0'))
          return err('Give a relative path inside the conversation files directory.')
        const scope = await createConversationFileScope(conversation)
        await scope.resolveBridgePath(relativePath)
        return ok(JSON.stringify({ file: await bot.publishFile(relativePath, name) }))
      } catch {
        return err(
          'Could not share the file. Check that it is a regular file inside this conversation files directory and that the storage quota has not been reached.'
        )
      }
    }
  )
}
