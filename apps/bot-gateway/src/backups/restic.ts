import { randomBytes } from 'node:crypto'
import {
  FLEET_BACKUP_LIMITS,
  type FleetBackupDestination,
  type FleetBackupErrorCode,
  type FleetBackupRetention,
  type FleetEnvironmentKind,
  fleetEnvironmentIdSchema,
} from '@maestrly/bot-fleet-protocol'
import type { HelperResult } from '../docker.js'

/** Where a helper mounts the environment's home volume: the same path as in the environment's container. */
export const BACKUP_HOME = '/home/bot'
/** The gateway's part of a backup, as `tarFiles` writes it into the helper and as the snapshot keeps it. */
export const BACKUP_SLICE_ENTRY = 'tmp/maestrly-backup/gateway.json'
export const BACKUP_SLICE_PATH = '/' + BACKUP_SLICE_ENTRY
/** The folder in the environment's profile where it writes its database copy (same value as the desktop module). */
export const BACKUP_STAGING_NAME = '.maestrly-backup-staging'
export const BACKUP_CACHE_DIR = '/cache/restic'

/** Folders of a browser profile that Chromium fills again by itself; the same list as the moves of bots. */
const CHROMIUM_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'component_crx_cache',
  'Crashpad',
]
/** What Maestrly downloads, measures or indexes again by itself in its profile. */
const APP_REBUILDABLE = [
  'runtime-assets',
  'transformers-cache',
  'vscode-cli',
  'vscode-serve-web',
  'fleet-media-cache',
  'bot-moves',
  'host-file-uploads',
  'host-file-archives',
  'maestrly-history-index.sqlite*',
  'workspace-data/*/memory-index.sqlite*',
]
/** What a project's tools install or build again from its sources. */
const PROJECT_REBUILDABLE = [
  'node_modules',
  '.venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  '.pytest_cache',
  '.mypy_cache',
]

/** The repository restic opens for a destination, and the credentials it reads from its environment. */
export function resticTarget(destination: FleetBackupDestination): { repository: string; env: Record<string, string> } {
  if (destination.provider === 's3') {
    const endpoint = (destination.endpoint ?? `https://s3.${destination.region}.amazonaws.com`).replace(/\/+$/, '')
    return {
      repository: `s3:${endpoint}/${destination.bucket}/${destination.prefix}`,
      env: {
        AWS_ACCESS_KEY_ID: destination.accessKeyId,
        AWS_SECRET_ACCESS_KEY: destination.secretAccessKey,
        AWS_DEFAULT_REGION: destination.region,
      },
    }
  }
  if (destination.provider === 'gcs')
    return {
      repository: `rclone:dest:${destination.bucket}/${destination.prefix}`,
      env: {
        RCLONE_CONFIG_DEST_TYPE: 'google cloud storage',
        RCLONE_CONFIG_DEST_SERVICE_ACCOUNT_CREDENTIALS: destination.serviceAccountJson,
        RCLONE_CONFIG_DEST_BUCKET_POLICY_ONLY: 'true',
      },
    }
  return {
    repository: `rclone:dest:${destination.folder}`,
    env: {
      RCLONE_CONFIG_DEST_TYPE: 'drive',
      RCLONE_CONFIG_DEST_SCOPE: 'drive.file',
      RCLONE_CONFIG_DEST_CLIENT_ID: destination.clientId,
      RCLONE_CONFIG_DEST_CLIENT_SECRET: destination.clientSecret,
      RCLONE_CONFIG_DEST_TOKEN: JSON.stringify({
        access_token: destination.token.accessToken,
        token_type: 'Bearer',
        refresh_token: destination.token.refreshToken,
        expiry: destination.token.expiry,
      }),
    },
  }
}
/** The environment of a helper that runs restic against a destination with a password. */
export function resticEnvironment(destination: FleetBackupDestination, password: string): string[] {
  const target = resticTarget(destination)
  return [
    `RESTIC_REPOSITORY=${target.repository}`,
    `RESTIC_PASSWORD=${password}`,
    `RESTIC_CACHE_DIR=${BACKUP_CACHE_DIR}`,
    'RESTIC_PROGRESS_FPS=0.5',
    'HOME=/tmp',
    // rclone writes a refreshed Drive token back to its configuration: a file in the helper, gone with it.
    'RCLONE_CONFIG=/tmp/rclone.conf',
    ...Object.entries(target.env).map(([name, value]) => `${name}=${value}`),
  ]
}

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url')
const decode = (text: string) => Buffer.from(text, 'base64url').toString('utf8')
/** The tags of an environment's snapshot; names are base64url so that commas and spaces survive restic's lists. */
export function snapshotTags(input: {
  environment: { id: string; name: string; kind: FleetEnvironmentKind }
  serverName: string
}): string[] {
  return [
    'maestrly',
    `format:${FLEET_BACKUP_LIMITS.sliceFormat}`,
    `env:${input.environment.id}`,
    `kind:${input.environment.kind}`,
    `name:${encode(input.environment.name)}`,
    `server-name:${encode(input.serverName)}`,
  ]
}
export type ParsedSnapshot = {
  id: string
  at: string
  host: string
  environmentId: string
  kind: FleetEnvironmentKind
  name: string
  serverName: string
  format: number
}
/** restic's times carry nanoseconds and an offset; the protocol's are milliseconds in UTC. */
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = new Date(value.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(time.getTime()) ? null : time.toISOString()
}
/** The Maestrly snapshots in what `restic snapshots --json` printed; others in the repository are left out. */
export function parseSnapshots(stdout: string): ParsedSnapshot[] {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const snapshots: ParsedSnapshot[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : []
    if (!tags.includes('maestrly')) continue
    const tag = (prefix: string) => tags.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
    const environmentId = tag('env:')
    const id = typeof entry.id === 'string' ? entry.id : ''
    const at = isoTime(entry.time)
    if (!environmentId || !fleetEnvironmentIdSchema.safeParse(environmentId).success) continue
    if (!/^[0-9a-f]{64}$/.test(id) || !at) continue
    const format = Number(tag('format:') ?? 1)
    const name = tag('name:')
    const serverName = tag('server-name:')
    snapshots.push({
      id,
      at,
      host: typeof entry.hostname === 'string' ? entry.hostname : '',
      environmentId,
      kind: tag('kind:') === 'workspaces' ? 'workspaces' : 'bots',
      name: (name && decode(name).slice(0, 200)) || environmentId,
      serverName: serverName ? decode(serverName).slice(0, 200) : '',
      format: Number.isSafeInteger(format) && format > 0 ? format : 1,
    })
  }
  return snapshots
}

/**
 * What a backup of the environment leaves out: what is rebuilt by itself, and the live database of a running
 * environment, whose consistent copy goes in instead. A stopped environment's database is copied as it is, and any
 * copy a backup left behind is skipped.
 */
export function backupExcludes(input: {
  running: boolean
  database: { live: string } | null
  projects: string | null
}): string[] {
  const home = BACKUP_HOME
  const excludes: string[] = []
  if (input.running && input.database) {
    const live = `${home}/${input.database.live}`
    excludes.push(live, `${live}-wal`, `${live}-shm`)
  } else excludes.push(`${home}/.config/**/${BACKUP_STAGING_NAME}`)
  excludes.push(`${home}/.cache`)
  for (const name of CHROMIUM_CACHES) excludes.push(`${home}/.config/**/${name}`)
  // A lock of Chromium or Electron restored in a new container would keep the browser and the app from opening.
  excludes.push(`${home}/.config/**/Singleton*`)
  for (const name of APP_REBUILDABLE) excludes.push(`${home}/.config/maestrly-app*/${name}`)
  // Tools the bots installed (~/.local) stay in on purpose: they are part of what each bot built. Dependencies are
  // left out only inside projects: skills and MCP servers in the home folder may run from their node_modules.
  for (const root of [`${home}/.config/maestrly-app*/worktrees`, `${home}/.config/maestrly-app*/standalone-chats`])
    for (const name of PROJECT_REBUILDABLE) excludes.push(`${root}/**/${name}`)
  if (input.projects) for (const name of PROJECT_REBUILDABLE) excludes.push(`${input.projects}/**/${name}`)
  return excludes
}
export function backupArgs(input: { host: string; tags: string[]; paths: string[]; excludes: string[] }): string[] {
  return [
    'backup',
    '--json',
    '--host',
    input.host,
    '--exclude-caches',
    ...input.tags.flatMap((tag) => ['--tag', tag]),
    ...input.excludes.flatMap((pattern) => ['--exclude', pattern]),
    '--',
    ...input.paths,
  ]
}
/** Forgets the environment's snapshots from this server beyond what the retention keeps. */
export function forgetArgs(input: { host: string; environmentId: string; retention: FleetBackupRetention }): string[] {
  const keep = (flag: string, count: number) => (count > 0 ? [flag, String(count)] : [])
  return [
    'forget',
    '--host',
    input.host,
    '--tag',
    `env:${input.environmentId}`,
    '--group-by',
    'host',
    ...keep('--keep-daily', input.retention.daily),
    ...keep('--keep-weekly', input.retention.weekly),
    ...keep('--keep-monthly', input.retention.monthly),
  ]
}
/** Restores one folder of a snapshot to the same path. */
export function restoreArgs(snapshotId: string, path: string): string[] {
  return ['restore', '--json', `${snapshotId}:${path}`, '--target', path]
}

function jsonLine(line: string): Record<string, unknown> | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
/** The progress of a backup or restore in one of restic's status lines. */
export function resticProgress(line: string): { percent: number; totalBytes: number | null } | null {
  const message = jsonLine(line)
  if (message?.message_type !== 'status' || typeof message.percent_done !== 'number') return null
  return { percent: Math.min(1, Math.max(0, message.percent_done)), totalBytes: count(message.total_bytes) }
}
/** The last summary of a backup: the snapshot it made and its sizes. */
export function resticBackupSummary(
  stdout: string
): { snapshotId: string; bytesAdded: number; bytesTotal: number } | null {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const message = jsonLine(lines[index])
    if (message?.message_type !== 'summary') continue
    const snapshotId = typeof message.snapshot_id === 'string' ? message.snapshot_id : ''
    if (!/^[0-9a-f]{64}$/.test(snapshotId)) return null
    return {
      snapshotId,
      bytesAdded: count(message.data_added) ?? 0,
      bytesTotal: count(message.total_bytes_processed) ?? 0,
    }
  }
  return null
}
export function resticStatsBytes(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    const size = count(jsonLine(line)?.total_size)
    if (size !== null) return size
  }
  return null
}

/** Each secret in `text` replaced, longest first so that one inside another does not leave a part behind. */
export function redact(text: string, secrets: string[]): string {
  let result = text
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[redacted]')
  return result
}
/** What restic said when it failed: its JSON exit error, or the last lines of its error output. */
function failureText(stderr: string): string {
  const lines = stderr.split('\n').filter((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index--) {
    const message = jsonLine(lines[index])
    if (message?.message_type === 'exit_error' && typeof message.message === 'string') return message.message
  }
  return lines
    .slice(-5)
    .map((line) => {
      const message = jsonLine(line)
      const error = message?.error as Record<string, unknown> | undefined
      return typeof error?.message === 'string' ? error.message : line
    })
    .join('\n')
}
const STORAGE_FULL =
  /storageQuotaExceeded|QuotaExceeded|quota exceeded|no space left|insufficient storage|EntityTooLarge/i
const UNREACHABLE =
  /no such host|connection refused|i\/o timeout|network is unreachable|dial tcp|TLS handshake timeout|connection reset|context deadline exceeded/i
const DENIED =
  /AccessDenied|Access Denied|InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden|\b403\b|\b401\b|invalid_grant|unauthorized|permission denied|insufficientPermissions/i
const NOT_FOUND = /NoSuchBucket|bucket does not exist|repository does not exist|notFound|\b404\b/i
const WRONG_KEY = /wrong password|no key found/i
const LOCKED = /unable to create lock|repository is already locked/i
/** A failed run of restic as the app shows it, with no secret in its message. */
export function resticFailure(
  result: HelperResult,
  secrets: string[]
): { code: FleetBackupErrorCode; message: string } {
  const text = failureText(result.stderr)
  const message = redact(text || `restic exited with code ${result.exitCode}`, secrets).slice(0, 500)
  let code: FleetBackupErrorCode
  if (result.ending === 'timeout') code = 'timeout'
  else if (result.ending === 'cancelled' || result.exitCode === 130) code = 'cancelled'
  else if (result.exitCode === 12) code = 'wrong-key'
  else if (result.exitCode === 11) code = 'locked'
  else if (result.exitCode === 10) code = 'not-found'
  else if (STORAGE_FULL.test(text)) code = 'storage-full'
  else if (UNREACHABLE.test(text)) code = 'unreachable'
  else if (WRONG_KEY.test(text)) code = 'wrong-key'
  else if (LOCKED.test(text)) code = 'locked'
  else if (DENIED.test(text)) code = 'denied'
  else if (NOT_FOUND.test(text)) code = 'not-found'
  else code = 'failed'
  return { code, message }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** A new recovery key: 160 random bits as 32 base32 characters, in groups of four. */
export function newRecoveryKey(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(20)
  let bits = 0
  let value = 0
  let text = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff
    bits += 8
    while (bits >= 5) {
      text += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return formatRecoveryKey(text)
}
/** A recovery key as typed (any case, spaces and dashes) as restic's password; null when it cannot be one. */
export function normalizeRecoveryKey(input: string): string | null {
  const value = input.toUpperCase().replace(/[\s-]+/g, '')
  return /^[A-Z2-7]{32}$/.test(value) ? value : null
}
export function formatRecoveryKey(normalized: string): string {
  return (normalized.match(/.{1,4}/g) ?? []).join('-')
}
