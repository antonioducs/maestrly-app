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
  const installRoot = path.resolve(skillInstallRoot(input.scope, input.cwd, input.home ?? os.homedir()))
  const dir = path.join(installRoot, located.name)
  // Disaster guard: empty/unusual names must never resolve to root (overwrite would delete EVERYTHING).
  if (!located.name || dir === installRoot || path.dirname(dir) !== installRoot)
    return { ok: false, error: 'invalid-skill-name' }
  await cleanupAbandonedInstallArtifacts(installRoot, located.name)
  const exists = await fsp
    .stat(dir)
    .then(() => true)
    .catch(() => false)
  if (exists && !input.overwrite) return { ok: false, error: 'already-exists', name: located.name, dir }
  // ATOMIC installation: extract/validate in sibling staging, swap by rename only at end — mid-flight failure (limits,
  // disk, permission) never loses the previous version. Dot prefix hides staging from listSkills.
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const staging = path.join(installRoot, `.tmp-${located.name}-${stamp}`)
  const backup = path.join(installRoot, `.bak-${located.name}-${stamp}`)
  try {
    await writeSkillFiles(entries, located.root, staging)
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    if (exists) await fsp.rename(dir, backup)
    await fsp.rename(staging, dir)
    if (exists) await fsp.rm(backup, { recursive: true, force: true }).catch(() => undefined)
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    // Restore the old version if already moved (rename silently fails if no backup exists).
    if (exists) await fsp.rename(backup, dir).catch(() => undefined)
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  recordInstalledSkill(located.name, {
    slug: `${slug.owner}/${slug.repo}@${slug.skill || located.name}`,
    source: `${slug.owner}/${slug.repo}`,
    scope: input.scope,
    dir,
    installedAt: Date.now(),
  })
  return { ok: true, name: located.name, dir }
}
