import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { z } from 'zod'
import { getAppSetting, setAppSetting } from '../../store'

const key = 'fleet.downloadHistory'
const entrySchema = z.object({
  receipt: z.string().uuid(),
  deviceId: z.string(),
  botId: z.string(),
  fileId: z.string(),
  path: z.string(),
})
type Entry = z.infer<typeof entrySchema>

function entries(): Entry[] {
  try {
    return z.array(entrySchema).parse(JSON.parse(getAppSetting(key) ?? '[]'))
  } catch {
    return []
  }
}

export function rememberFleetDownload(deviceId: string, botId: string, fileId: string, path: string): string {
  const receipt = randomUUID()
  const history = entries()
  history.push({ receipt, deviceId, botId, fileId, path })
  setAppSetting(key, JSON.stringify(history))
  return receipt
}

async function existing(entry: Entry | undefined): Promise<Entry | null> {
  if (!entry) return null
  try {
    return (await lstat(entry.path)).isFile() ? entry : null
  } catch {
    return null
  }
}

/** Pairing identity survives tunnel URL changes and separates identical IDs on different gateways. */
export async function findFleetDownload(deviceId: string, botId: string, fileId: string): Promise<string | null> {
  for (const entry of entries().reverse()) {
    if (entry.deviceId === deviceId && entry.botId === botId && entry.fileId === fileId && (await existing(entry)))
      return entry.receipt
  }
  return null
}

/** Only a receipt created by main can reveal a path; never take a path from the renderer. */
export async function fleetDownloadPath(receipt: string): Promise<string> {
  const entry = await existing(entries().find((item) => item.receipt === receipt))
  if (!entry) throw new Error('FLEET_LOCAL_DOWNLOAD_MISSING')
  return entry.path
}
