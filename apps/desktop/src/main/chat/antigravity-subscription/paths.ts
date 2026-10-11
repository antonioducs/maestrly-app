import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/** accountId becomes a directory name; separators or `..` would allow path traversal during logout. */
const FILESYSTEM_SAFE_ACCOUNT_ID = /^[A-Za-z0-9_-]+$/

/**
 * Variables the Antigravity process may inherit. Everything else in Maestrly's environment (API keys, provider
 * tokens, NODE_OPTIONS, ...) stays out. Display and D-Bus variables let the server open the sign-in page on Linux.
 */
const PASSTHROUGH_ENV = new Set(
  [
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'BROWSER',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP',
    'XDG_SESSION_TYPE',
    'DBUS_SESSION_BUS_ADDRESS',
  ].map((name) => name.toUpperCase())
)

export function antigravityDataRoot(userData: string = app.getPath('userData')): string {
  return path.join(userData, 'antigravity')
}

export function antigravityAccountsRoot(userData: string = app.getPath('userData')): string {
  return path.join(antigravityDataRoot(userData), 'accounts')
}

export function antigravityAccountRoot(accountId: string | null, userData: string = app.getPath('userData')): string {
  if (accountId !== null && !FILESYSTEM_SAFE_ACCOUNT_ID.test(accountId)) {
    throw new Error(`Invalid Google AI subscription account id: ${accountId}`)
  }
  return path.join(antigravityAccountsRoot(userData), accountId ?? 'default')
}

export const antigravityGeminiHome = (root: string): string => path.join(root, '.gemini')
/** Scratch cwd of every ACP session: the server loads hooks from its cwd, so it must never be a user project. */
export const antigravityWorkDir = (root: string): string => path.join(root, 'work')
export const antigravityAcpHome = (root: string): string => path.join(antigravityGeminiHome(root), 'antigravity-acp')
export const antigravityTokenPath = (root: string): string => path.join(antigravityAcpHome(root), 'acp_token.json')

/**
 * Reads only the non-secret `project_id` of the ACP token file. The refresh token and client secret are never
 * returned, logged, or copied.
 */
export function readAntigravityProjectId(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(antigravityTokenPath(root), 'utf8')) as { project_id?: unknown } | null
    const projectId = parsed?.project_id
    return typeof projectId === 'string' && projectId.trim() ? projectId : null
  } catch {
    return null
  }
}

export function antigravityFingerprint(projectId: string): string {
  return `project:${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}`
}

export function buildAntigravityProcessEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && PASSTHROUGH_ENV.has(name.toUpperCase())) env[name] = value
  }
  env.HOME = root
  env.USERPROFILE = root
  env.GEMINI_HOME = antigravityGeminiHome(root)
  // Keeps the OAuth token in the per-account directory instead of the shared macOS Keychain.
  env.AGY_ACP_FORCE_FILE_STORAGE = '1'
  return env
}

/** The ACP registry launches the Linux build with an empty `--uid=` argument. */
export function antigravityLaunchArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'linux' ? ['--uid='] : []
}

export function antigravityServerExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
}

/** Guards destructive cleanup: the path must be strictly inside `parent`. */
export function isStrictlyInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}
