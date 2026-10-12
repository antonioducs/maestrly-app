import fsp from 'node:fs/promises'
import path from 'node:path'

export type RelativePathResult =
  | { ok: true; segments: string[] }
  | { ok: false; reason: 'not-relative' | 'escapes' | 'invalid' }

/**
 * Parses a plugin-relative path from a manifest: it must start with `./` (or be exactly `.`) and stay inside the
 * plugin root lexically. Filesystem containment (symlinks) is checked separately with `assertRealpathInside`.
 */
export function parsePluginRelativePath(value: string): RelativePathResult {
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' }
  if (value.includes('\\') || value.includes('\0')) return { ok: false, reason: 'invalid' }
  if (value === '.') return { ok: true, segments: [] }
  if (!value.startsWith('./')) return { ok: false, reason: 'not-relative' }
  const segments: string[] = []
  for (const part of value.slice(2).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!segments.length) return { ok: false, reason: 'escapes' }
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return { ok: true, segments }
}

/** A repository-relative POSIX path as Git reports it; never absolute, never `..`, never inside `.git`. */
export function isSafeTreePath(p: string): boolean {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git')
}

/** Joins segments under `root`; throws `path-unsafe` when the result leaves it. */
export function resolveInsideRoot(root: string, segments: readonly string[]): string {
  const base = path.resolve(root)
  const abs = path.resolve(base, ...segments)
  const rel = path.relative(base, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path-unsafe')
  return abs
}

/** Resolves symlinks of both paths and throws `path-unsafe` unless `abs` stays inside `root`. */
export async function assertRealpathInside(root: string, abs: string): Promise<string> {
  let realRoot: string
  let target: string
  try {
    ;[realRoot, target] = await Promise.all([fsp.realpath(root), fsp.realpath(abs)])
  } catch {
    throw new Error('path-unsafe')
  }
  const rel = path.relative(realRoot, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path-unsafe')
  return target
}

/** Joins tree-path segments (POSIX). */
export function joinTreePath(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}
