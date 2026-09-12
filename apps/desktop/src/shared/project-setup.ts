export const PROJECT_SETUP_ERROR_CODES = [
  'git-not-found',
  'git-incompatible',
  'invalid-request',
  'invalid-path',
  'invalid-name',
  'invalid-url',
  'embedded-credentials',
  'destination-exists',
  'not-git-repository',
  'bare-repository',
  'initialization-failed',
  'initial-commit-failed',
  'clone-authentication-failed',
  'clone-network-failed',
  'remote-not-found',
  'clone-failed',
  'registration-failed',
  'operation-conflict',
  'cleanup-incomplete',
] as const

export type ProjectSetupErrorCode = (typeof PROJECT_SETUP_ERROR_CODES)[number]

export type ProjectSetupRequest =
  | { operationId: string; kind: 'open'; path: string }
  | { operationId: string; kind: 'initialize-existing'; path: string }
  | { operationId: string; kind: 'create'; parentPath: string; name: string }
  | {
      operationId: string
      kind: 'clone'
      parentPath: string
      name: string
      remoteUrl: string
      defaultBranch?: string
    }

export type ProjectSetupPhase =
  | 'validating'
  | 'preparing'
  | 'initializing-git'
  | 'creating-readme'
  | 'creating-initial-commit'
  | 'receiving-objects'
  | 'resolving-deltas'
  | 'awaiting-empty-remote-confirmation'
  | 'registering'
  | 'cleaning-up'
  | 'completed'
  | 'canceling'

export interface ProjectSetupProgress {
  operationId: string
  phase: ProjectSetupPhase
  percent?: number
}

export interface ProjectSetupError {
  code: ProjectSetupErrorCode
  cleanupIncomplete?: boolean
}

export type ProjectSetupResult<TWorkspace> =
  | { status: 'success'; workspace: TWorkspace; reused: boolean }
  | { status: 'needs-initialization'; path: string }
  | { status: 'canceled' }
  | { status: 'error'; error: ProjectSetupError }

export type EmptyRemoteDecision = 'initialize-local' | 'cancel'

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const NON_PORTABLE_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/
const NETWORK_GIT_PROTOCOL = /^(?:https?|ssh|git):$/i

export function isSafeProjectName(value: string): boolean {
  const name = value.trim()
  return (
    name.length > 0 &&
    name.length <= 120 &&
    name !== '.' &&
    name !== '..' &&
    !NON_PORTABLE_NAME_CHARS.test(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !/[. ]$/.test(name) &&
    !WINDOWS_RESERVED_NAME.test(name)
  )
}

export function suggestProjectName(remoteUrl: string): string {
  const clean = remoteUrl
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/[/\\]+$/, '')
  const last = clean.split(/[/\\:]/).pop() ?? ''
  return last.replace(/\.git$/i, '')
}

export function validateGitRemoteUrl(
  remoteUrl: string
): { valid: true } | { valid: false; code: 'invalid-url' | 'embedded-credentials' } {
  const value = remoteUrl.trim()
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
    return { valid: false, code: 'invalid-url' }
  }

  if (/^(?:https?|ssh|git):\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (!NETWORK_GIT_PROTOCOL.test(url.protocol) || !url.hostname) {
        return { valid: false, code: 'invalid-url' }
      }

      if (url.password || (url.username && url.protocol !== 'ssh:') || url.search || url.hash) {
        return { valid: false, code: 'embedded-credentials' }
      }
      return { valid: true }
    } catch {
      return { valid: false, code: 'invalid-url' }
    }
  }

  if (/^file:\/\//i.test(value)) {
    if (/^file:\/\/[^/]*@/i.test(value)) return { valid: false, code: 'embedded-credentials' }
    try {
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
        ? { valid: true }
        : { valid: false, code: 'embedded-credentials' }
    } catch {
      return { valid: false, code: 'invalid-url' }
    }
  }

  if (/^[^\s/@:]+@[^\s/:]+:.+$/.test(value)) {
    return /[?#]/.test(value) ? { valid: false, code: 'embedded-credentials' } : { valid: true }
  }
  if (/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(value)) return { valid: true }

  if (!/[\s:@]/.test(value)) return { valid: true }
  return { valid: false, code: 'invalid-url' }
}

export function isProjectSetupRequest(value: unknown): value is ProjectSetupRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (typeof request.operationId !== 'string' || typeof request.kind !== 'string') return false
  if (request.kind === 'open' || request.kind === 'initialize-existing') {
    return typeof request.path === 'string'
  }
  if (request.kind === 'create') {
    return typeof request.parentPath === 'string' && typeof request.name === 'string'
  }
  if (request.kind === 'clone') {
    return (
      typeof request.parentPath === 'string' &&
      typeof request.name === 'string' &&
      typeof request.remoteUrl === 'string' &&
      (request.defaultBranch === undefined || typeof request.defaultBranch === 'string')
    )
  }
  return false
}
