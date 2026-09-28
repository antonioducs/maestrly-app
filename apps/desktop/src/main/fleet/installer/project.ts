import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { FleetEgress } from '../../../shared/fleet-installer'

/**
 * The Compose project Maestrly installs: the repository's `deploy/bot-fleet/compose.yml`, shipped with the app, and an
 * `.env` Maestrly writes. It lives in `<userData>/bot-server/` on this computer and in `/opt/maestrly-bots/` on a VPS.
 */
export const BOT_SERVER_PROJECT = 'maestrly-bots'
export const BOT_SERVER_SERVICE = 'maestrly-bot-gateway'
export const BOT_SERVER_REMOTE_DIR = '/opt/maestrly-bots'
/** `npm run bot-fleet:dev`'s project: a development app refuses to install beside it. */
export const BOT_SERVER_DEV_PROJECT = 'maestrly-fleet-dev'
/** The gateway's public port inside its container, published or tunneled to this computer. */
export const BOT_SERVER_GATEWAY_PORT = 7443

export interface BotServerEnvValues {
  gatewayImage: string
  botImage: string
  port: number
  displayName: string
  egress: FleetEgress
  timezone: string
}

const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/
const timezonePattern = /^[A-Za-z0-9_+/-]+$/

export function renderBotServerEnv(values: BotServerEnvValues): string {
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error('Invalid port')
  for (const image of [values.gatewayImage, values.botImage])
    if (!imagePattern.test(image)) throw new Error('Invalid image reference')
  if (values.egress !== 'open' && values.egress !== 'public') throw new Error('Invalid egress')
  if (!timezonePattern.test(values.timezone)) throw new Error('Invalid time zone')
  const displayName = displayNameFor(values.displayName)
  return [
    `MAESTRLY_GATEWAY_IMAGE=${values.gatewayImage}`,
    `MAESTRLY_GATEWAY_BOT_IMAGE=${values.botImage}`,
    'MAESTRLY_GATEWAY_BIND=127.0.0.1',
    `MAESTRLY_GATEWAY_PORT=${values.port}`,
    // Single quotes keep Compose from interpolating; `displayNameFor` removes quotes, `$` and backslashes.
    `MAESTRLY_GATEWAY_DISPLAY_NAME='${displayName}'`,
    `MAESTRLY_GATEWAY_BOT_EGRESS=${values.egress}`,
    `MAESTRLY_GATEWAY_NETWORK=${BOT_SERVER_PROJECT}`,
    `TZ=${values.timezone}`,
    '',
  ].join('\n')
}

export function parseBotServerEnv(text: string): {
  gatewayImage: string | null
  botImage: string | null
  egress: FleetEgress | null
  port: number | null
} {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0])
      value = value.slice(1, -1)
    values.set(match[1], value)
  }
  const image = (key: string) => {
    const value = values.get(key)
    return value && imagePattern.test(value) ? value : null
  }
  const egress = values.get('MAESTRLY_GATEWAY_BOT_EGRESS')
  const port = Number(values.get('MAESTRLY_GATEWAY_PORT'))
  return {
    gatewayImage: image('MAESTRLY_GATEWAY_IMAGE'),
    botImage: image('MAESTRLY_GATEWAY_BOT_IMAGE'),
    egress: egress === 'open' || egress === 'public' ? egress : null,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
  }
}

/** The values Maestrly changes in an installed server's `.env`: its images and what bots may reach. */
export type BotServerEnvChanges = Partial<
  Record<'MAESTRLY_GATEWAY_IMAGE' | 'MAESTRLY_GATEWAY_BOT_IMAGE' | 'MAESTRLY_GATEWAY_BOT_EGRESS', string>
>

/** The `.env` with these values replaced, or appended when missing; every other line stays as it was. */
export function withEnvValues(text: string, changes: BotServerEnvChanges): string {
  for (const [key, value] of Object.entries(changes)) {
    const valid =
      key === 'MAESTRLY_GATEWAY_BOT_EGRESS' ? value === 'open' || value === 'public' : imagePattern.test(value ?? '')
    if (!valid) throw new Error(`Invalid ${key}`)
  }
  const pending = new Map(Object.entries(changes) as Array<[string, string]>)
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const updated = lines.map((line) => {
    const key = /^\s*([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1]
    if (!key || !pending.has(key)) return line
    const value = pending.get(key)
    pending.delete(key)
    return `${key}=${value}`
  })
  for (const [key, value] of pending) updated.push(`${key}=${value}`)
  return `${updated.filter((line, index) => line || index < updated.length - 1).join('\n')}\n`
}

/** An image reference's repository and tag; a registry port is not a tag. */
export function splitImageRef(ref: string): { repository: string; tag: string | null } {
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  return colon > slash ? { repository: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { repository: ref, tag: null }
}

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The version an image's tag names; null for a digest, no tag, or a tag that is not a version (`local`). */
export function imageVersion(ref: string): string | null {
  if (ref.includes('@')) return null
  const name = ref.slice(ref.lastIndexOf('/') + 1)
  const colon = name.lastIndexOf(':')
  if (colon < 0) return null
  const tag = name.slice(colon + 1)
  return semverPattern.test(tag) ? tag : null
}

/** A server name the gateway shows, safe in a single-quoted `.env` value. */
export function displayNameFor(hostname: string): string {
  const name = hostname
    .replace(/\p{Cc}/gu, ' ')
    .replace(/['"$`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim()
  return name || 'Maestrly'
}

export function timezoneOrUtc(zone: string | undefined): string {
  if (!zone || !timezonePattern.test(zone)) return 'Etc/UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return 'Etc/UTC'
  }
}

/** `docker` arguments that run Compose on the installed project, whatever the working directory. */
export function composeArgs(dir: string, join: (...parts: string[]) => string): string[] {
  return [
    'compose',
    '--project-name',
    BOT_SERVER_PROJECT,
    '--project-directory',
    dir,
    '--file',
    join(dir, 'compose.yml'),
    '--env-file',
    join(dir, '.env'),
  ]
}

/** The Compose file shipped with the app, or the checkout's in a development build. */
export function bundledComposePath(
  location: { isPackaged?: boolean; resourcesPath?: string; appPath?: string; cwd?: string } = {}
): string {
  const isPackaged = location.isPackaged ?? app.isPackaged
  if (isPackaged) return path.join(location.resourcesPath ?? process.resourcesPath, 'bot-server', 'compose.yml')
  const appPath = location.appPath ?? app.getAppPath()
  const relative = path.join('deploy', 'bot-fleet', 'compose.yml')
  const roots = [appPath, path.resolve(appPath, '..', '..'), location.cwd ?? process.cwd()]
  const root =
    roots.find((candidate) => existsSync(path.join(candidate, relative))) ?? path.resolve(appPath, '..', '..')
  return path.join(root, relative)
}
