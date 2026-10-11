/**
 * Public skill library (skills.sh) + NATIVE installer.
 *
 * Search: `GET https://skills.sh/api/search?q=` (site's only public JSON API). Installation: download public repository
 * TARBALL from `codeload.github.com`, extract in memory (own ustar parser — no OS `tar` or
 * `npx skills`, which would require user-installed Node), find the requested skill's `SKILL.md` folder,
 * and copy to `~/.agents/skills/<name>` (global) or `<cwd>/.agents/skills/<name>` (project).
 *
 * Skills installed through `npx skills` still appear normally (same directories) — the local manifest
 * (app_settings `chat.skills.installed`) only tracks ORIGIN for skills installed here (updates).
 */
import { createHash } from 'node:crypto'
import { assertSafeSkillPath, withSkillMutation } from './skill-document'
import { FLEET_PROVISIONING_LIMITS, fleetSkillNameSchema } from '@maestrly/bot-fleet-protocol'
import { packageSkillDirectory } from './skill-package'
import { gunzipSync } from 'node:zlib'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAppSetting, setAppSetting } from '../store'
import { normalizedSkillName, skillInstallRoot, type ChatSkillScope } from './skills'
import type { ChatSkillSearchHit } from '../../shared/chat'

const SEARCH_URL = 'https://skills.sh/api/search'
const SEARCH_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 90_000
const MAX_TARBALL_BYTES = 80 * 1024 * 1024
/** Gunzip EXPANSION cap (decompression-bomb defense: small gz → huge tar). */
const MAX_TAR_EXPANDED_BYTES = 512 * 1024 * 1024
/** Tar header cap (guards tarballs containing millions of tiny entries). */
const MAX_TAR_ENTRIES = 20_000
const MAX_SKILL_FILES = 400
const MAX_SKILL_BYTES = 20 * 1024 * 1024
/** Newer artifacts may belong to another app instance; clean only safely orphaned ones. */
const ABANDONED_INSTALL_ARTIFACT_MS = 30 * 60 * 1000
const INSTALLED_KEY = 'chat.skills.installed'

export interface InstalledSkillRecord {
  slug: string
  source: string
  scope: ChatSkillScope
  dir: string
  installedAt: number
}

function readManifest(): Record<string, InstalledSkillRecord> {
  const raw = getAppSetting(INSTALLED_KEY)
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, InstalledSkillRecord>)
      : {}
  } catch {
    return {}
  }
}

/** Skill name → origin slug (only app-installed skills). */
export function listInstalledSkillSources(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, record] of Object.entries(readManifest())) {
    if (record?.slug) out[name] = record.slug
  }
  return out
}

export function recordInstalledSkill(name: string, record: InstalledSkillRecord): void {
  setAppSetting(INSTALLED_KEY, JSON.stringify({ ...readManifest(), [name]: record }))
}

export function forgetInstalledSkill(name: string): void {
  const manifest = readManifest()
  if (!(name in manifest)) return
  delete manifest[name]
  setAppSetting(INSTALLED_KEY, JSON.stringify(manifest))
}

// ---------- Search ----------

/** `owner/repo/skill` → installation slug `owner/repo@skill`. */
function hitSlug(id: string, source: string, name: string): string {
  const skillId = id.startsWith(`${source}/`) ? id.slice(source.length + 1) : name
  return `${source}@${skillId}`
}

export function parseSearchResponse(payload: unknown, installedNames: ReadonlySet<string>): ChatSkillSearchHit[] {
  const skills = (payload as { skills?: unknown })?.skills
  if (!Array.isArray(skills)) return []
  const out: ChatSkillSearchHit[] = []
  for (const raw of skills) {
    const item = raw as { id?: unknown; name?: unknown; source?: unknown; installs?: unknown }
    if (typeof item?.id !== 'string' || typeof item?.name !== 'string' || typeof item?.source !== 'string') continue
    // The API also lists non-GitHub sources (e.g. `react-aria.adobe.com`) — installer can only download
    // codeload (`owner/repo`), so exclude hits that would be clickable but uninstallable.
    if (item.source.split('/').filter(Boolean).length !== 2) continue
    out.push({
      id: item.id,
      name: item.name,
      source: item.source,
      installs: typeof item.installs === 'number' ? item.installs : 0,
      slug: hitSlug(item.id, item.source, item.name),
      url: `https://skills.sh/${item.id}`,
      installed: installedNames.has(normalizedSkillName(item.name)),
    })
  }
  return out
}

export async function searchSkillLibrary(
  query: string,
  installedNames: ReadonlySet<string> = new Set()
): Promise<{ ok: boolean; hits: ChatSkillSearchHit[]; error?: string }> {
  const q = (query ?? '').trim()
  if (!q) return { ok: true, hits: [] }
  try {
    const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return { ok: false, hits: [], error: `http-${res.status}` }
    return { ok: true, hits: parseSearchResponse(await res.json(), installedNames) }
  } catch (e) {
    return { ok: false, hits: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- slug ----------

export interface SkillSlug {
  owner: string
  repo: string
  /** Requested skill (folder or frontmatter `name`). Absent = single-skill repository. */
  skill?: string
  ref?: string
}

/** Accepts `owner/repo@skill`, `owner/repo/skill`, `owner/repo`, GitHub or skills.sh URLs. */
export function parseSkillSlug(input: string): SkillSlug | null {
  let value = (input ?? '').trim()
  if (!value) return null
  value = value.replace(/^https?:\/\//, '').replace(/^(?:www\.)?(?:github\.com|skills\.sh)\//, '')
  value = value.replace(/\.git(?=$|[/@])/, '').replace(/\/+$/, '')
  const [pathPart, atSkill] = value.split('@')
  const segments = pathPart.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const [owner, repo, ...rest] = segments
  let ref: string | undefined
  let tail = rest
  // GitHub tree URL: owner/repo/tree/<ref>/<path...>.
  if (tail[0] === 'tree' || tail[0] === 'blob') {
    ref = tail[1]
    tail = tail.slice(2)
  }
  const skill = (atSkill || tail[tail.length - 1] || '').trim()
  return { owner, repo, ...(skill ? { skill } : {}), ...(ref ? { ref } : {}) }
}

// ---------- tar.gz (ustar) ----------

export interface TarEntry {
  path: string
  data: Buffer
}

function octal(buf: Buffer): number {
  const text = buf.toString('utf8').replace(/\0.*$/, '').trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/**
 * Minimal ustar parser: iterates 512-byte blocks, accepts regular files ('0'/'\0'), skips directories and
 * extended headers (pax 'x'/'g'); handles GNU longname ('L'). Sufficient for codeload tarballs.
 */
export function readTarEntries(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = []
  let offset = 0
  let longName: string | null = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // Empty block = end.
    if (out.length >= MAX_TAR_ENTRIES) throw new Error('too-many-entries')
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = octal(header.subarray(124, 136))
    const type = String.fromCharCode(header[156]) || '0'
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    const padded = Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '')
    } else if (type === '0' || type === '\0') {
      const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
      longName = null
      out.push({ path: name, data: tar.subarray(dataStart, dataEnd) })
    } else {
      longName = null
    }
    offset = dataStart + padded
  }
  return out
}

/** `maxBytes` caps gunzip OUTPUT (abort decompression bombs before materializing the entire tar). */
export function readTarGzEntries(gz: Buffer, maxBytes: number = MAX_TAR_EXPANDED_BYTES): TarEntry[] {
  let tar: Buffer
  try {
    tar = gunzipSync(gz, { maxOutputLength: maxBytes })
  } catch (e) {
    if (e instanceof RangeError || (e as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE')
      throw new Error('tarball-too-large')
    throw e
  }
  return readTarEntries(tar)
}

/** Frontmatter `name:` (without full parsing) — skills.sh skillId comes from here, not the folder. */
function frontmatterName(content: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return ''
  const nm = /^name:\s*(.+)$/m.exec(m[1])
  return nm ? nm[1].trim().replace(/^["']|["']$/g, '') : ''
}

export interface LocatedSkill {
  /** Tarball prefix, e.g. `agent-skills-HEAD/skills/react-best-practices`. */
  root: string
  /** Resolved name (frontmatter → folder). */
  name: string
  /** All available tarball names (for useful errors). */
  available: string[]
}

/** Finds the requested skill folder in a tarball: matches frontmatter `name` OR folder name. */
export function locateSkill(entries: readonly TarEntry[], wanted?: string): LocatedSkill | null {
  const candidates: { root: string; folder: string; name: string }[] = []
  for (const entry of entries) {
    if (!entry.path.endsWith('/SKILL.md')) continue
    const root = entry.path.slice(0, -'/SKILL.md'.length)
    const folder = root.split('/').pop() ?? ''
    const declared = frontmatterName(entry.data.toString('utf8'))
    // A `name:` normalizing to empty (e.g. `!!!`) falls back to the folder — an empty name would make
    // destination == installation root (overwriting would delete ALL skills).
    candidates.push({ root, folder, name: normalizedSkillName(declared || folder) || normalizedSkillName(folder) })
  }
  if (!candidates.length) return null
  const available = candidates.map((c) => c.name)
  const target = normalizedSkillName(wanted ?? '')
  const match =
    (target && candidates.find((c) => c.name === target || normalizedSkillName(c.folder) === target)) ||
    (candidates.length === 1 ? candidates[0] : null)
  if (!match) return { root: '', name: '', available }
  return { root: match.root, name: match.name, available }
}

// ---------- Installation ----------

export interface InstallSkillResult {
  ok: boolean
  error?: string
  name?: string
  dir?: string
  /** Available names when the slug does not identify a unique skill. */
  available?: string[]
}

async function downloadTarball(owner: string, repo: string, ref: string): Promise<Buffer> {
  const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`http-${res.status}`)
  if (!res.body) throw new Error('no-body')
  // Apply cap DURING streaming — `arrayBuffer()` would materialize the entire response before checking.
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_TARBALL_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('tarball-too-large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** Safe relative tarball path segments: reject `\` (Windows separator!), absolute paths,
 * drive letters, and `.`/`..`. null = discard entry. */
function safeRelSegments(rel: string): string[] | null {
  if (!rel || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null
  const segments = rel.split('/').filter(Boolean)
  if (!segments.length) return null
  for (const segment of segments) if (segment === '.' || segment === '..') return null
  return segments
}

/** Writes skill files (prefiltered entries) to `dir`, recreating the relative tree. */
export async function writeSkillFiles(entries: readonly TarEntry[], root: string, dir: string): Promise<number> {
  let written = 0
  let bytes = 0
  const base = path.resolve(dir)
  await fsp.mkdir(base, { recursive: true })
  for (const entry of entries) {
    if (!entry.path.startsWith(`${root}/`)) continue
    const rel = entry.path.slice(root.length + 1)
    const segments = safeRelSegments(rel)
    if (!segments) continue
    // Defense in depth: RESOLVED destination must remain under the skill folder.
    const target = path.resolve(base, ...segments)
    if (target !== base && !target.startsWith(base + path.sep)) continue
    if (++written > MAX_SKILL_FILES) throw new Error('too-many-files')
    bytes += entry.data.byteLength
    if (bytes > MAX_SKILL_BYTES) throw new Error('skill-too-large')
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, entry.data)
    if (segments[0] === 'scripts') await fsp.chmod(target, 0o755).catch(() => undefined)
  }
  return written
}

type InstallArtifact = { path: string; kind: 'staging' | 'backup'; mtimeMs: number }

/**
 * Removes orphan staging/backups for this skill. If an old replacement stopped after moving the previous version
 * to backup, restore the newest backup first instead of discarding it. Leave recent artifacts
 * intact: another Maestrly instance may still be installing them.
 */
async function cleanupAbandonedInstallArtifacts(installRoot: string, name: string, now = Date.now()): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(installRoot, { withFileTypes: true })
  } catch {
    return
  }
  const stagingPrefix = `.tmp-${name}-`
  const backupPrefix = `.bak-${name}-`
  const artifacts: InstallArtifact[] = []
  for (const entry of entries) {
    const kind = entry.name.startsWith(stagingPrefix)
      ? 'staging'
      : entry.name.startsWith(backupPrefix)
        ? 'backup'
        : null
    if (!kind) continue
    const artifactPath = path.join(installRoot, entry.name)
    const stat = await fsp.lstat(artifactPath).catch(() => null)
    if (!stat || now - stat.mtimeMs < ABANDONED_INSTALL_ARTIFACT_MS) continue
    artifacts.push({ path: artifactPath, kind, mtimeMs: stat.mtimeMs })
  }

  const target = path.join(installRoot, name)
  let targetExists = await fsp
    .lstat(target)
    .then(() => true)
    .catch(() => false)
  const backups = artifacts.filter((artifact) => artifact.kind === 'backup').sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (!targetExists && backups.length) {
    const latest = backups.shift()!
    try {
      await fsp.rename(latest.path, target)
      targetExists = true
    } catch {
      // Preserve all backups on recovery failure; cleanup must not destroy the last good version.
      backups.unshift(latest)
    }
  }

  const removable = artifacts.filter(
    (artifact) => artifact.kind === 'staging' || (targetExists && backups.includes(artifact))
  )
  await Promise.all(
    removable.map((artifact) => fsp.rm(artifact.path, { recursive: true, force: true }).catch(() => undefined))
  )
}

/** Installs (or updates with `overwrite`) a public-library skill. */
export async function installSkillFromSlug(input: {
  slug: string
  scope: ChatSkillScope
  cwd: string
  overwrite?: boolean
  expectedName?: string
  beforeCommit?: () => Promise<void>
  home?: string
}): Promise<InstallSkillResult> {
  const slug = parseSkillSlug(input.slug)
  if (!slug) return { ok: false, error: 'invalid-slug' }
  if (input.scope === 'project' && !input.cwd) return { ok: false, error: 'no-cwd' }
  let entries: TarEntry[]
  try {
    entries = readTarGzEntries(await downloadTarball(slug.owner, slug.repo, slug.ref || 'HEAD'))
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const located = locateSkill(entries, slug.skill)
  if (!located) return { ok: false, error: 'no-skill-in-repo' }
  if (!located.root) return { ok: false, error: 'ambiguous-skill', available: located.available }
  if (input.expectedName && located.name !== input.expectedName) return { ok: false, error: 'skill-name-mismatch' }
  const installRoot = path.resolve(skillInstallRoot(input.scope, input.cwd, input.home ?? os.homedir()))
  const dir = path.join(installRoot, located.name)
  // Disaster guard: empty/unusual names must never resolve to root (overwrite would delete EVERYTHING).
  if (!located.name || dir === installRoot || path.dirname(dir) !== installRoot)
    return { ok: false, error: 'invalid-skill-name' }
  return withSkillMutation(dir, async () => {
    await assertSafeSkillPath(installRoot, true)
    await cleanupAbandonedInstallArtifacts(installRoot, located.name)
    const exists = await fsp
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    if (exists && !input.overwrite) return { ok: false, error: 'already-exists', name: located.name, dir }
    const files: SkillFile[] = []
    for (const entry of entries) {
      if (!entry.path.startsWith(located.root + '/')) continue
      const segments = safeRelSegments(entry.path.slice(located.root.length + 1))
      if (segments) files.push({ path: segments.join('/'), data: entry.data, executable: segments[0] === 'scripts' })
    }
    try {
      await installSkillFiles({
        name: located.name,
        files,
        root: installRoot,
        source: 'registry',
        beforeCommit: input.beforeCommit,
        provenance: {
          slug: `${slug.owner}/${slug.repo}@${slug.skill || located.name}`,
          source: `${slug.owner}/${slug.repo}`,
          scope: input.scope,
          dir,
          installedAt: Date.now(),
        },
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, name: located.name, dir }
  })
}

export interface SkillFile {
  path: string
  data: Buffer
  executable: boolean
}
export type SkillInstallOutcome = 'added' | 'updated' | 'unchanged'

export function skillFilesProblem(files: readonly SkillFile[]): string | null {
  if (files.length > FLEET_PROVISIONING_LIMITS.skillFilesMax) return 'too-many-files'
  let bytes = 0
  const paths = new Set<string>()
  for (const file of files) {
    if (
      !file.path ||
      file.path.length > FLEET_PROVISIONING_LIMITS.skillPathMax ||
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      /^[A-Za-z]:/.test(file.path) ||
      file.path.split('/').some((segment) => !segment || segment.startsWith('.'))
    )
      return 'invalid-path'
    if (paths.has(file.path)) return 'duplicate-path'
    paths.add(file.path)
    bytes += file.data.byteLength
    if (
      file.data.byteLength > FLEET_PROVISIONING_LIMITS.skillFileBytesMax ||
      bytes > FLEET_PROVISIONING_LIMITS.skillBytesMax
    )
      return 'too-large'
  }
  return paths.has('SKILL.md') ? null : 'no-skill-md'
}

export function skillFilesDigest(files: readonly SkillFile[]): string {
  const digest = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    digest
      .update(file.path)
      .update('\0')
      .update(String(file.executable))
      .update('\0')
      .update(createHash('sha256').update(file.data).digest('hex'))
  }
  return digest.digest('hex')
}

type SkillFilesInstallInput = {
  name: string
  files: readonly SkillFile[]
  beforeCommit?: () => Promise<void>
  root?: string
} & ({ source: 'fleet' } | { source: 'registry'; provenance: InstalledSkillRecord })

/** Shares the atomic swap with registry installs, which retain their existing archive limits and provenance. */
export async function installSkillFiles(
  input: SkillFilesInstallInput
): Promise<{ outcome: SkillInstallOutcome; dir: string }> {
  const root = path.resolve(input.root ?? skillInstallRoot('global', ''))
  return withSkillMutation(path.join(root, input.name), async () => {
    await assertSafeSkillPath(root, true)
    return installSkillFilesUnlocked(input)
  })
}

async function installSkillFilesUnlocked(
  input: SkillFilesInstallInput
): Promise<{ outcome: SkillInstallOutcome; dir: string }> {
  const installRoot = path.resolve(input.root ?? skillInstallRoot('global', ''))
  const dir = path.join(installRoot, input.name)
  if (
    !input.name ||
    dir === installRoot ||
    path.dirname(dir) !== installRoot ||
    (input.source === 'fleet' && !fleetSkillNameSchema.safeParse(input.name).success)
  )
    throw new Error('invalid-skill-name')
  if (input.source === 'fleet') {
    const problem = skillFilesProblem(input.files)
    if (problem) throw new Error(problem)
  } else {
    if (input.files.some((file) => file.path.includes('\0') || !safeRelSegments(file.path)))
      throw new Error('invalid-path')
    if (input.files.length > MAX_SKILL_FILES) throw new Error('too-many-files')
    if (input.files.reduce((total, file) => total + file.data.byteLength, 0) > MAX_SKILL_BYTES)
      throw new Error('skill-too-large')
  }
  await cleanupAbandonedInstallArtifacts(installRoot, input.name)
  const existing = await fsp.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  const provenance =
    input.source === 'registry'
      ? input.provenance
      : {
          slug: 'fleet',
          source: 'fleet',
          scope: 'global' as const,
          dir,
          installedAt: Date.now(),
        }
  if (input.source === 'fleet' && existing && (existing.isDirectory() || existing.isSymbolicLink())) {
    const current = await packageSkillDirectory(dir).catch(() => null)
    // Windows stores no executable bit, so an installed script there always reads as not executable.
    const comparable = (files: readonly SkillFile[]) =>
      process.platform === 'win32' ? files.map((file) => ({ ...file, executable: false })) : files
    if (current && skillFilesDigest(comparable(current)) === skillFilesDigest(comparable(input.files))) {
      recordInstalledSkill(input.name, provenance)
      return { outcome: 'unchanged', dir }
    }
  }
  await assertSafeSkillPath(dir, true)
  // Stage beside the destination so both renames stay on the same filesystem.
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const staging = path.join(installRoot, `.tmp-${input.name}-${stamp}`)
  const backup = path.join(installRoot, `.bak-${input.name}-${stamp}`)
  try {
    await fsp.mkdir(staging, { recursive: true })
    for (const file of input.files) {
      const target = path.join(staging, file.path)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, file.data)
      await fsp.chmod(target, file.executable ? 0o755 : 0o644)
    }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  let backedUp = false
  let swapped = false
  try {
    await input.beforeCommit?.()
    await assertSafeSkillPath(dir, true)
    if (existing) {
      await fsp.rename(dir, backup)
      backedUp = true
    }
    await fsp.rename(staging, dir)
    swapped = true
    recordInstalledSkill(input.name, provenance)
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    if (swapped) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    if (backedUp) await fsp.rename(backup, dir).catch(() => undefined)
    throw error
  }
  if (backedUp) await fsp.rm(backup, { recursive: true, force: true }).catch(() => undefined)
  return { outcome: existing ? 'updated' : 'added', dir }
}

export async function removeGlobalSkill(name: string, root = skillInstallRoot('global', '')): Promise<boolean> {
  return withSkillMutation(path.join(root, name), async () => {
    await assertSafeSkillPath(root, true)
    await assertSafeSkillPath(path.join(root, name), true)
    return removeGlobalSkillUnlocked(name, root)
  })
}

async function removeGlobalSkillUnlocked(name: string, root: string): Promise<boolean> {
  if (!fleetSkillNameSchema.safeParse(name).success) throw new Error('invalid-skill-name')
  const dir = path.join(root, name)
  const exists = await fsp.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!exists) return false
  await fsp.rm(dir, { recursive: true, force: true })
  forgetInstalledSkill(name)
  return true
}
