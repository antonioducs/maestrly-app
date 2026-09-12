export interface CanonicalGitRemote {
  canonicalKey: string
  host: string
  repositoryPath: string
}

function normalizedPath(value: string): string | null {
  let path = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (!path || path.includes('..') || path.includes('?') || path.includes('#')) return null
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2 || segments.some((segment) => !segment.trim())) return null
  return segments.join('/').toLowerCase()
}

export function canonicalizeGitRemote(remoteUrl: string): CanonicalGitRemote | null {
  const value = remoteUrl.trim()
  if (!value || /[\r\n\0]/.test(value)) return null

  const scp = /^(?:[^\s/@:]+)@([^\s/:]+):(.+)$/.exec(value)
  if (scp) {
    const host = scp[1]!.toLowerCase()
    const repositoryPath = normalizedPath(scp[2]!)
    return repositoryPath ? { host, repositoryPath, canonicalKey: `${host}/${repositoryPath}` } : null
  }

  if (!/^(?:https?|ssh|git):\/\//i.test(value)) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null
    if (url.password || url.search || url.hash) return null
    if (url.username && url.protocol !== 'ssh:') return null
    const host = url.hostname.toLowerCase()
    const repositoryPath = normalizedPath(url.pathname)
    return repositoryPath ? { host, repositoryPath, canonicalKey: `${host}/${repositoryPath}` } : null
  } catch {
    return null
  }
}

export function gitRemotesMatch(left: string, right: string): boolean {
  const a = canonicalizeGitRemote(left)
  const b = canonicalizeGitRemote(right)
  return !!a && !!b && a.canonicalKey === b.canonicalKey
}

function canonicalRepositoryKey(value: string): CanonicalGitRemote | null {
  const key = value.trim().toLowerCase()
  const separator = key.indexOf('/')
  if (separator <= 0) return null
  const host = key.slice(0, separator)
  const repositoryPath = normalizedPath(key.slice(separator + 1))
  if (!repositoryPath || `${host}/${repositoryPath}` !== key) return null
  return { host, repositoryPath, canonicalKey: key }
}

export function pullRequestUrlMatchesCanonicalRepo(value: string, canonicalKey: string): boolean {
  const repository = canonicalRepositoryKey(canonicalKey)
  if (!repository) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    const path = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase()
    return url.hostname.toLowerCase() === repository.host && path.startsWith(`${repository.repositoryPath}/`)
  } catch {
    return false
  }
}
