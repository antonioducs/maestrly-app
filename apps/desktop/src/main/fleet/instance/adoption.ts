import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LEGACY_BOT_MEMORY_SPACE_ID, botMemorySpaceId } from '../../memory/spaces'
import { getAppSetting, rekeyLocalMemorySpace, setAppSetting, transaction } from '../../store'
import { settledLog } from './queue'
import {
  LEGACY_PAUSED_KEY,
  LEGACY_PROFILE_KEY,
  botSettingKey,
  deleteSettings,
  parseStoredProfile,
  readInstalledBots,
  writeInstalledBots,
} from './registry'

export type AdoptionResult = { adopted: false } | { adopted: true; botId: string }

const INPUT_FOLDER = /^[a-f0-9-]{36}$/
const IMAGE_FILE = /^t-[A-Za-z0-9_-]{32}$/

/** Where a container from before environments kept its single bot's files. */
function legacyLayout(userData: string) {
  return {
    inputs: path.join(userData, 'fleet-instance', 'inputs.json'),
    transcript: path.join(userData, 'fleet-instance', 'transcript.json'),
    inputsLog: settledLog(path.join(userData, 'fleet-instance', 'inputs.json')),
    transcriptLog: settledLog(path.join(userData, 'fleet-instance', 'transcript.json')),
    attachments: path.join(userData, 'fleet-inputs'),
    images: path.join(userData, 'fleet-images'),
  }
}
function adoptedLayout(userData: string, botId: string) {
  const folder = path.join(userData, 'fleet-instance', 'bots', botId)
  return {
    inputs: path.join(folder, 'inputs.json'),
    transcript: path.join(folder, 'transcript.json'),
    inputsLog: settledLog(path.join(folder, 'inputs.json')),
    transcriptLog: settledLog(path.join(folder, 'transcript.json')),
    attachments: path.join(userData, 'fleet-inputs', botId),
    images: path.join(userData, 'fleet-images', botId),
  }
}

function log(level: 'info' | 'error', message: string): void {
  console.error(JSON.stringify({ component: 'bot-instance', level, message }))
}

async function entries(folder: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(folder, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
async function isFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file)
    return stat.isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Makes `to` an exact copy of the legacy file `from`, or removes `to` when there is no legacy file. The copy is a hard
 * link when the file system allows it (the legacy file is never written in place afterwards: every store replaces its
 * files by renaming, and a settled log, which grows in place, is removed with the legacy files once adopted), and
 * replaces whatever an interrupted attempt left there.
 */
async function mirrorFile(from: string, to: string): Promise<void> {
  if (!(await isFile(from))) {
    await fs.rm(to, { force: true })
    return
  }
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
  const temporary = `${to}.${randomUUID()}.adopting`
  try {
    try {
      await fs.link(from, temporary)
    } catch {
      await fs.copyFile(from, temporary)
    }
    await fs.rename(temporary, to)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Mirrors the legacy entries of `fromRoot` that `pattern` matches into `toRoot`, and drops other matching entries. */
async function mirrorEntries(
  fromRoot: string,
  toRoot: string,
  pattern: RegExp,
  kind: 'file' | 'folder'
): Promise<void> {
  const legacy = (await entries(fromRoot)).filter(
    (entry) => pattern.test(entry.name) && (kind === 'file' ? entry.isFile() : entry.isDirectory())
  )
  const names = new Set(legacy.map((entry) => entry.name))
  for (const entry of legacy) {
    const from = path.join(fromRoot, entry.name)
    const to = path.join(toRoot, entry.name)
    if (kind === 'file') {
      await mirrorFile(from, to)
      continue
    }
    const files = (await entries(from)).filter((file) => file.isFile()).map((file) => file.name)
    await fs.mkdir(to, { recursive: true, mode: 0o700 })
    for (const file of files) await mirrorFile(path.join(from, file), path.join(to, file))
    for (const stale of await entries(to))
      if (!files.includes(stale.name)) await fs.rm(path.join(to, stale.name), { recursive: true, force: true })
  }
  for (const stale of await entries(toRoot))
    if (pattern.test(stale.name) && !names.has(stale.name))
      await fs.rm(path.join(toRoot, stale.name), { recursive: true, force: true })
}

/** Removes the legacy files once the adoption is committed. Anything left over is removed at the next start. */
async function removeLegacyFiles(userData: string): Promise<void> {
  const legacy = legacyLayout(userData)
  await fs.rm(legacy.inputs, { force: true })
  await fs.rm(legacy.transcript, { force: true })
  await fs.rm(legacy.inputsLog, { force: true })
  await fs.rm(legacy.transcriptLog, { force: true })
  for (const entry of await entries(legacy.attachments))
    if (INPUT_FOLDER.test(entry.name))
      await fs.rm(path.join(legacy.attachments, entry.name), { recursive: true, force: true })
  for (const entry of await entries(legacy.images))
    if (IMAGE_FILE.test(entry.name)) await fs.rm(path.join(legacy.images, entry.name), { force: true })
  await fs.rm(path.join(legacy.images, 'index.json'), { force: true })
}

/**
 * Adopts the single bot of a container from before environments, found by its `fleet.instance.profile` setting, as
 * the bot in slot 1 of an environment. It has no gateway token until the gateway installs it again.
 *
 * Until the commit the legacy data stays authoritative: its files are copied (not moved) into the bot's folders,
 * replacing whatever an interrupted attempt left there. The commit is one database transaction that writes the bot's
 * settings, moves its memories from `bot-self` to `bot-self:<botId>`, installs it and removes the legacy settings.
 * Only then are the legacy files removed. A failure at any step leaves the legacy bot as it was, and the next start
 * tries again; after the commit, adoption does nothing but remove legacy leftovers.
 */
export async function adoptLegacyBot(options: { userData: string }): Promise<AdoptionResult> {
  const raw = getAppSetting(LEGACY_PROFILE_KEY)
  const installed = readInstalledBots()
  if (raw === null) {
    if (installed.length) await removeLegacyFiles(options.userData)
    return { adopted: false }
  }
  // An instance that already has bots (for example after running an older Maestrly again) is left alone.
  if (installed.length) return { adopted: false }
  const stored = parseStoredProfile(raw)
  const botId = stored.profile.botId
  const paused = getAppSetting(LEGACY_PAUSED_KEY)
  const legacy = legacyLayout(options.userData)
  const target = adoptedLayout(options.userData, botId)

  await mirrorFile(legacy.inputs, target.inputs)
  await mirrorFile(legacy.transcript, target.transcript)
  await mirrorFile(legacy.inputsLog, target.inputsLog)
  await mirrorFile(legacy.transcriptLog, target.transcriptLog)
  await mirrorEntries(legacy.attachments, target.attachments, INPUT_FOLDER, 'folder')
  await mirrorEntries(legacy.images, target.images, IMAGE_FILE, 'file')
  await mirrorFile(path.join(legacy.images, 'index.json'), path.join(target.images, 'index.json'))

  transaction(() => {
    setAppSetting(botSettingKey(botId, 'profile'), JSON.stringify(stored))
    if (paused === null) deleteSettings([botSettingKey(botId, 'paused')])
    else setAppSetting(botSettingKey(botId, 'paused'), paused)
    deleteSettings([botSettingKey(botId, 'gatewayToken')])
    rekeyLocalMemorySpace(LEGACY_BOT_MEMORY_SPACE_ID, botMemorySpaceId(botId))
    writeInstalledBots([{ botId, slot: 1 }])
    deleteSettings([LEGACY_PROFILE_KEY, LEGACY_PAUSED_KEY])
  })
  log('info', `Adopted the bot ${botId} of this container as the bot in slot 1.`)

  try {
    await removeLegacyFiles(options.userData)
  } catch (error) {
    log(
      'error',
      `Legacy bot files stay until the next start: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return { adopted: true, botId }
}
