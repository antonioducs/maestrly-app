import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  FLEET_ENVIRONMENT_LIMITS,
  fleetBotIdSchema,
  fleetInstanceProfileSchema,
  type FleetInstanceProfile,
} from '@maestrly/bot-fleet-protocol'
import { z } from 'zod'
import { getAppSetting, getDb, setAppSetting, transaction } from '../../store'
import { secureGet, secureSet } from '../../secure-store'

/**
 * What an environment remembers about its bots. The installed list is the commit point of a bot's membership: a bot
 * is recreated on start only once it is in the list, and uninstalling removes it from the list first. Each bot keeps
 * its settings under `fleet.instance.bots.<botId>.*`, its gateway token encrypted.
 */
export const INSTALLED_BOTS_KEY = 'fleet.instance.bots'
/** Settings of a container from before environments, when it ran a single bot. */
export const LEGACY_PROFILE_KEY = 'fleet.instance.profile'
export const LEGACY_PAUSED_KEY = 'fleet.instance.paused'

export interface InstalledBot {
  botId: string
  slot: number
}
export interface StoredProfile {
  profile: FleetInstanceProfile
  primaryConversationId: string | null
}
export type BotSetting = 'profile' | 'paused' | 'gatewayToken'
const BOT_SETTINGS: readonly BotSetting[] = ['profile', 'paused', 'gatewayToken']

const slotSchema = z.number().int().min(1).max(FLEET_ENVIRONMENT_LIMITS.botsMax)
const installedSchema = z
  .array(z.object({ botId: fleetBotIdSchema, slot: slotSchema }))
  .max(FLEET_ENVIRONMENT_LIMITS.botsMax)
  .refine(
    (bots) =>
      new Set(bots.map((bot) => bot.botId)).size === bots.length &&
      new Set(bots.map((bot) => bot.slot)).size === bots.length,
    'bots and slots must be unique'
  )

export function isBotId(value: string): boolean {
  return fleetBotIdSchema.safeParse(value).success
}
export function assertBotId(botId: string): string {
  if (!isBotId(botId)) throw new TypeError(`Invalid bot id ${JSON.stringify(botId)}.`)
  return botId
}
export function botSettingKey(botId: string, setting: BotSetting): string {
  return `${INSTALLED_BOTS_KEY}.${assertBotId(botId)}.${setting}`
}

export function readInstalledBots(): InstalledBot[] {
  const raw = getAppSetting(INSTALLED_BOTS_KEY)
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Invalid installed bots setting.')
  }
  const parsed = installedSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid installed bots setting.')
  return parsed.data.map((bot) => ({ botId: bot.botId, slot: bot.slot })).sort((a, b) => a.slot - b.slot)
}
export function writeInstalledBots(bots: InstalledBot[]): void {
  const value = installedSchema.parse(
    bots.map((bot) => ({ botId: bot.botId, slot: bot.slot })).sort((a, b) => a.slot - b.slot)
  )
  setAppSetting(INSTALLED_BOTS_KEY, JSON.stringify(value))
}

export function parseStoredProfile(raw: string): StoredProfile {
  try {
    const value = JSON.parse(raw) as { profile?: unknown; primaryConversationId?: unknown }
    return {
      profile: fleetInstanceProfileSchema.parse(value.profile),
      primaryConversationId: z
        .string()
        .min(1)
        .nullable()
        .parse(value.primaryConversationId ?? null),
    }
  } catch {
    throw new Error('Invalid persisted bot instance profile.')
  }
}
export function readStoredProfile(botId: string): StoredProfile | null {
  const raw = getAppSetting(botSettingKey(botId, 'profile'))
  return raw ? parseStoredProfile(raw) : null
}
export function writeStoredProfile(botId: string, value: StoredProfile): void {
  if (value.profile.botId !== botId) throw new Error('A bot profile must keep its bot id.')
  setAppSetting(botSettingKey(botId, 'profile'), JSON.stringify(value))
}
export function readBotPaused(botId: string): boolean {
  return getAppSetting(botSettingKey(botId, 'paused')) === '1'
}
export function writeBotPaused(botId: string, paused: boolean): void {
  setAppSetting(botSettingKey(botId, 'paused'), paused ? '1' : '0')
}

/** Tokens kept only for this process when the keyring is unavailable; never written in plain text. */
const memoryTokens = new Map<string, string>()
export function readGatewayToken(botId: string): string | null {
  return secureGet(botSettingKey(botId, 'gatewayToken')) ?? memoryTokens.get(botId) ?? null
}
export function writeGatewayToken(botId: string, token: string): 'secure' | 'memory' {
  const key = botSettingKey(botId, 'gatewayToken')
  if (secureSet(key, token)) {
    memoryTokens.delete(botId)
    return 'secure'
  }
  memoryTokens.set(botId, token)
  deleteSettings([key])
  return 'memory'
}
export function clearGatewayToken(botId: string): void {
  memoryTokens.delete(botId)
  deleteSettings([botSettingKey(botId, 'gatewayToken')])
}
export function deleteBotSettings(botId: string): void {
  memoryTokens.delete(botId)
  deleteSettings(BOT_SETTINGS.map((setting) => botSettingKey(botId, setting)))
}
export function deleteSettings(keys: readonly string[]): void {
  const statement = getDb().prepare('DELETE FROM app_settings WHERE key = ?')
  transaction(() => {
    for (const key of keys) statement.run(key)
  })
}

/** Where one bot keeps its own files: storage in Maestrly's data folder and its browser profile in the home folder. */
export interface BotPaths {
  folder: string
  inputs: string
  transcript: string
  attachments: string
  images: string
  browserConfig: string
  cache: string
}
export function botPaths(userData: string, home: string, botId: string): BotPaths {
  assertBotId(botId)
  const folder = path.join(userData, 'fleet-instance', 'bots', botId)
  return {
    folder,
    inputs: path.join(folder, 'inputs.json'),
    transcript: path.join(folder, 'transcript.json'),
    attachments: path.join(userData, 'fleet-inputs', botId),
    images: path.join(userData, 'fleet-images', botId),
    browserConfig: path.join(home, '.config', 'maestrly-bots', botId),
    cache: path.join(home, '.cache', 'maestrly-bots', botId),
  }
}

/**
 * Deletes a bot's own folder `base/segments…/<botId>`. The folder above it must really be inside `base`: another
 * program of the environment may have replaced a folder with a link, and a purge never follows it elsewhere. A link in
 * place of the bot folder itself is removed, not followed.
 */
export async function removeBotFolder(base: string, segments: readonly string[], botId: string): Promise<void> {
  assertBotId(botId)
  let realBase: string
  let realParent: string
  try {
    realBase = await fs.realpath(base)
    realParent = await fs.realpath(path.join(base, ...segments))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (realParent !== path.join(realBase, ...segments))
    throw new Error(`Refusing to delete the folder of bot ${botId} behind a link.`)
  await fs.rm(path.join(realParent, botId), { recursive: true, force: true })
}
