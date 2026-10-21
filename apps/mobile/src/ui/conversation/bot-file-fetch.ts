import { FLEET_FILE_LIMITS, type FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { cachedFilePath } from '../../fleet/bot-files'
import type { FleetController } from '../../fleet/controller'
import { GatewayError } from '../../gateway/client'
import type { BotFileAccess } from './CueCard'

export type FileIssueKind = 'gone' | 'offline' | 'tooLarge' | 'demo' | 'unavailable'

/** Why a file a bot shared could not reach the phone, as `botFiles.error.*` says it. */
export class FileIssue extends Error {
  constructor(readonly issue: FileIssueKind) {
    super(issue)
  }
}

/** How a bot's conversations and its Files sheet reach the files it shared. */
export function botFileAccess(controller: FleetController, botId: string, demo: boolean): BotFileAccess {
  return {
    serverId: controller.source.serverId,
    botId,
    demo,
    source: (fileId) => controller.source.fileSource(botId, fileId),
    check: (fileId) => controller.source.call('botFileMeta', { params: { id: botId, fileId } }),
  }
}

type FetchOptions = { signal?: AbortSignal; onProgress?: (share: number | null) => void }

/** The file in the app's cache, downloaded once: the gateway serves whole files, so a video cannot stream. */
export async function fetchBotFile(
  access: BotFileAccess | null | undefined,
  file: FleetFileRef,
  options: FetchOptions = {}
): Promise<File> {
  if (!access) throw new FileIssue('unavailable')
  if (access.demo) throw new FileIssue('demo')
  if (file.byteSize > FLEET_FILE_LIMITS.downloadMaxBytes) throw new FileIssue('tooLarge')
  const target = new File(Paths.cache, cachedFilePath(access.serverId, access.botId, file.id, file.name))
  if (target.exists && target.size === file.byteSize) return target
  try {
    await access.check(file.id)
  } catch (error) {
    throw new FileIssue(error instanceof GatewayError && error.code === 'NOT_FOUND' ? 'gone' : 'offline')
  }
  try {
    target.parentDirectory.create({ intermediates: true, idempotent: true })
    const { uri, headers } = access.source(file.id)
    return await File.downloadFileAsync(uri, target, {
      headers,
      idempotent: true,
      signal: options.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const total = totalBytes > 0 ? totalBytes : file.byteSize
        options.onProgress?.(total > 0 ? Math.min(1, bytesWritten / total) : null)
      },
    })
  } catch {
    throw new FileIssue('offline')
  }
}

/** Downloads a file and hands it to the system's share menu, where the owner saves or sends it. */
export async function shareBotFile(
  access: BotFileAccess | null | undefined,
  file: FleetFileRef,
  options: FetchOptions = {}
): Promise<void> {
  const saved = await fetchBotFile(access, file, options)
  await Sharing.shareAsync(saved.uri, { mimeType: file.mediaType, dialogTitle: file.name })
}

/** Drops the phone's cached copy of a file the bot deleted; a copy saved elsewhere stays. */
export function forgetCachedBotFile(
  access: Pick<BotFileAccess, 'serverId' | 'botId'>,
  file: { id: string; name: string }
): void {
  try {
    const cached = new File(Paths.cache, cachedFilePath(access.serverId, access.botId, file.id, file.name))
    if (cached.exists) cached.delete()
  } catch {
    // A copy that cannot be removed now is only cache, which the system can clear.
  }
}
