import path from 'node:path'
import { FLEET_FILE_LIMITS } from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { createConversationFileScope } from '../../conversation-file-scope'
import { botRuntimeForConversation } from '../../fleet/instance'
import { FleetFileQuotaError } from '../../fleet/instance/files'
import { getConversation } from '../../store/conversations'
import { err, ok, type McpToolContext } from './context'

const MIB = 1024 ** 2
const size = (bytes: number) =>
  bytes < 1024 * MIB ? `${(bytes / MIB).toFixed(1)} MiB` : `${(bytes / 1024 / MIB).toFixed(1)} GiB`

/** What the bot tells its owner when a limit refused the file; the owner frees or raises space in Files. */
function quotaMessage(error: FleetFileQuotaError): string {
  const { usage } = error
  if (error.reason === 'size')
    return `Could not share the file: it is ${size(error.fileBytes)}, and a shared file can be at most ${FLEET_FILE_LIMITS.downloadMaxBytes / MIB} MiB. Compress or split it, then share the parts.`
  if (error.reason === 'count')
    return `Could not share the file: this bot already keeps ${usage.countMax} shared files, the most it can. Tell your owner they can delete some in Files, at the top of your conversation, then try again.`
  return `Could not share the file: it is ${size(error.fileBytes)}, and only ${size(Math.max(0, usage.quotaBytes - usage.usedBytes))} of this bot's ${size(usage.quotaBytes)} for shared files are free. Tell your owner they can free space or raise it in Files, at the top of your conversation, then try again.`
}

export function registerBotFileTools(ctx: McpToolContext): void {
  ctx.server.registerTool(
    'bot_share_file',
    {
      description:
        "Share a file from your conversation files directory privately with your owner. Give a relative path and an optional download name. A snapshot is retained even if you edit the source later. The returned file reference is automatically shown as a download card; do not invent a download URL. Shared files count toward this bot's space, which the owner manages in Files.",
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
        return ok(JSON.stringify({ file: await bot.publishFile(relativePath, name, ctx.convId) }))
      } catch (error) {
        if (error instanceof FleetFileQuotaError) return err(quotaMessage(error))
        return err(
          'Could not share the file. Check that it is a regular file inside this conversation files directory.'
        )
      }
    }
  )
}
