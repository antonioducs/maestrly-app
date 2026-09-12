/**
 * Project chat skills — FOLDER-based capability packages (unlike text slash-command templates).
 * Each skill directory contains `SKILL.md` (frontmatter + instruction body) in `<cwd>/.agents/skills/<name>/`,
 * `<cwd>/.claude/skills/<name>/`, or `<cwd>/.codex/skills/<name>/` (+ global equivalents under `~`).
 *
 * Three levels of progressive disclosure:
 *   1. CATALOG (name+description) in system prompt;
 *   2. SKILL.md body loaded on demand via `use_skill` (model) or `/name` (user);
 *   3. BUNDLED files (`scripts/`, `references/`, `assets/`) read/executed with read/bash —
 *      hence `dir` (absolute root) and inventory accompany the body.
 *
 * This module is PURE (fs/path only) — enablement state (global + conversation) lives in `skill-state.ts`,
 * which depends on the store.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeCommandName } from './commands'

export type ChatSkillScope = 'project' | 'global'

/** Canonical skill-name normalization (same rules as slash commands). */
export const normalizedSkillName = normalizeCommandName

export interface ChatSkill {
  name: string
  description: string
  body: string
  /** Readable source label, e.g. `.agents/skills/review/SKILL.md`. */
  source: string
  /** ABSOLUTE skill folder — root for `scripts/`, `references/`, `assets/` resolution. */
  dir: string
  scope: ChatSkillScope
  /** Argument hint for `/` palette (`argument-hint` frontmatter). */
  argumentHint?: string
  license?: string
  /** `disable-model-invocation: true` → excluded from system-prompt catalog and use_skill. */
  modelInvocable: boolean
  /** `user-invocable: false` → excluded from `/` palette. */
  userInvocable: boolean
  /** Bundled files RELATIVE to `dir` (e.g. `scripts/run.sh`). */
  resources: string[]
  /** Body truncated at safety cap. */
  truncated?: boolean
}

/** Body safety cap. Spec recommends <5k words; this only guards against huge files. */
export const SKILL_BODY_MAX_CHARS = 64_000
/** SKILL.md READ cap (bytes): never materialize hostile/accidental files hundreds of MB large —
 * read only this prefix (> SKILL_BODY_MAX_CHARS, so character cap remains authoritative). */
const SKILL_FILE_MAX_BYTES = 256 * 1024
/** Bundled-file inventory cap (prevents prompt overflow for skills with hundreds of assets). */
const MAX_RESOURCES = 60
const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const
export type SkillResourceKind = (typeof RESOURCE_DIRS)[number]

const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.codex/skills'] as const

/** Skill directories: PROJECT (cwd) + GLOBAL (home) — Claude Code installs globals in ~/.claude/skills.
 * Project wins deduplication (more specific). Deduplicate absolute paths (cwd may be home). Inject `home`
 * parameter (default os.homedir()) for tests. Empty `cwd` = global roots only (Settings,
 * which has no conversation/cwd). */
function skillDirs(cwd: string, home: string): { dir: string; label: string; scope: ChatSkillScope }[] {
  const list: { dir: string; label: string; scope: ChatSkillScope }[] = []
  if (cwd) for (const rel of SKILL_ROOTS) list.push({ dir: path.join(cwd, rel), label: rel, scope: 'project' })
  for (const rel of SKILL_ROOTS) list.push({ dir: path.join(home, rel), label: `~/${rel}`, scope: 'global' })
  const seen = new Set<string>()
  return list.filter((entry) => {
    if (seen.has(entry.dir)) return false
    seen.add(entry.dir)
    return true
  })
}

/** Root for new/installed skills (always `.agents/skills`, Maestrly's native format). */
export function skillInstallRoot(scope: ChatSkillScope, cwd: string, home: string = os.homedir()): string {
  return path.join(scope === 'project' ? cwd : home, '.agents/skills')
}

type Frontmatter = { fields: Record<string, string>; body: string }

/** SIMPLE YAML frontmatter: top-level scalars + block scalars (`|`/`>`, common for long descriptions).
 * Nested maps (e.g. `metadata:`) remain ignored. */
function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s/.test(line)) continue // Indented line = nested block value.
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    const block = /^([|>])[+-]?$/.exec(value)
    if (block) {
      // Block scalar: collect subsequent indented lines ('>' folds to spaces; '|' preserves newlines).
      const collected: string[] = []
      while (i + 1 < lines.length && (lines[i + 1] === '' || /^\s/.test(lines[i + 1]))) {
        i += 1
        collected.push(lines[i].replace(/^\s+/, ''))
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop()
      fields[key] = (block[1] === '>' ? collected.join(' ') : collected.join('\n')).trim()
      continue
    }
    fields[key] = value.replace(/^["']|["']$/g, '')
  }
  return { fields, body: text.slice(m[0].length) }
}

function boolField(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'no' || v === '0') return false
  return fallback
}

/** Lists bundled files (scripts/references/assets), relative to skill dir. Depth 2. */
async function listResources(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const sub of RESOURCE_DIRS) {
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (out.length >= MAX_RESOURCES || depth > 2) return
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_RESOURCES) return
        if (e.name.startsWith('.')) continue
        const childRel = `${rel}/${e.name}`
        if (e.isDirectory()) await walk(childRel, depth + 1)
        else out.push(childRel)
      }
    }
    await walk(sub, 1)
  }
  return out
}

/** File count per category (UI badge). */
export function countSkillResources(resources: readonly string[]): Record<SkillResourceKind, number> {
  const counts: Record<SkillResourceKind, number> = { scripts: 0, references: 0, assets: 0 }
  for (const rel of resources) {
    const kind = rel.split('/')[0] as SkillResourceKind
    if (kind in counts) counts[kind] += 1
  }
  return counts
}

/** Reads at most SKILL_FILE_MAX_BYTES (never materializes huge SKILL.md). null = unreadable. */
async function readSkillFileCapped(file: string): Promise<{ text: string; clipped: boolean } | null> {
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await fsp.open(file, 'r')
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    const size = Math.min(stat.size, SKILL_FILE_MAX_BYTES)
    const buf = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buf, 0, size, 0)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), clipped: stat.size > bytesRead }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readSkillFolder(
  dir: string,
  folder: string,
  label: string,
  scope: ChatSkillScope
): Promise<ChatSkill | null> {
  const skillDir = path.join(dir, folder)
  const raw = await readSkillFileCapped(path.join(skillDir, 'SKILL.md'))
  if (!raw) return null // Folder lacks SKILL.md / unreadable.
  const { fields, body } = parseFrontmatter(raw.text)
  const name = normalizeCommandName(fields.name || folder)
  const content = body.trim()
  if (!name || !content) return null
  const truncated = raw.clipped || content.length > SKILL_BODY_MAX_CHARS
  return {
    name,
    description: (fields.description || '').trim(),
    body: truncated ? content.slice(0, SKILL_BODY_MAX_CHARS) + '\n… (truncated)' : content,
    source: `${label}/${folder}/SKILL.md`,
    dir: skillDir,
    scope,
    argumentHint: fields['argument-hint'] || undefined,
    license: fields.license || undefined,
    modelInvocable: !boolField(fields['disable-model-invocation'], false),
    userInvocable: boolField(fields['user-invocable'], true),
    resources: await listResources(skillDir),
    ...(truncated ? { truncated: true } : {}),
  }
}

/** Lists project + global (~) skills. Each folder with SKILL.md; accepts SYMLINKED folders (e.g. Claude Code
 * global skills are symlinks). Deduplicate by name (project beats global; within a scope, precedence
 * is .agents, .claude, then .codex). */
export async function listSkills(cwd: string, home: string = os.homedir()): Promise<ChatSkill[]> {
  const out: ChatSkill[] = []
  const seen = new Set<string>()
  for (const { dir, label, scope } of skillDirs(cwd, home)) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue // Directory does not exist → ignore.
    }
    for (const e of entries) {
      // Accept directory OR symlink (Claude Code global skills are often symlinks → isDirectory()=false).
      if (e.name.startsWith('.') || (!e.isDirectory() && !e.isSymbolicLink())) continue
      const skill = await readSkillFolder(dir, e.name, label, scope)
      if (!skill || seen.has(skill.name)) continue
      out.push(skill)
      seen.add(skill.name)
    }
  }
  return out
}

/** Skill by normalized name. null if absent. */
export async function findSkill(cwd: string, name: string, home: string = os.homedir()): Promise<ChatSkill | null> {
  const norm = normalizeCommandName(name)
  if (!norm) return null
  return (await listSkills(cwd, home)).find((s) => s.name === norm) ?? null
}

/** Skill body (full instructions) by name. null if absent. */
export async function readSkillBody(cwd: string, name: string, home: string = os.homedir()): Promise<string | null> {
  return (await findSkill(cwd, name, home))?.body ?? null
}

// ---------- User invocation (`/name args`) ----------

/** Recognizes `/name [args]` at message START. Same PURE function as renderer's optimistic chip. */
export { parseSlashInvocation as parseSkillInvocation } from '../../shared/chat'

/** Replaces `$ARGUMENTS` and positional `$1..$9` in body. `consumed` = args already entered text. */
export function applySkillArguments(body: string, args: string): { text: string; consumed: boolean } {
  const positional = args.match(/\S+/g) ?? []
  let consumed = false
  let text = body.replace(/\$ARGUMENTS\b/g, () => {
    consumed = true
    return args
  })
  text = text.replace(/\$([1-9])/g, (whole, digit: string) => {
    const value = positional[Number(digit) - 1]
    if (value === undefined) return whole
    consumed = true
    return value
  })
  return { text, consumed }
}

/**
 * Skill context block: header + ABSOLUTE ROOT + file inventory + instructions. This text is
 * returned by `use_skill` and injected by `/name` — identical shape for both paths.
 */
export function renderSkillContext(
  skill: ChatSkill,
  opts: { args?: string; invokedBy?: 'user' | 'model' } = {}
): string {
  const args = (opts.args ?? '').trim()
  const expanded = applySkillArguments(skill.body, args)
  const lines: string[] = []
  lines.push(
    opts.invokedBy === 'user'
      ? `The user invoked the skill "${skill.name}" for this turn. Follow these instructions.`
      : `Skill "${skill.name}" loaded. Follow these instructions for this task.`
  )
  if (skill.description) lines.push(skill.description)
  lines.push(`Skill directory (any relative path below resolves from here): ${skill.dir}`)
  if (skill.resources.length) {
    lines.push(
      `Bundled files: ${skill.resources.join(', ')}. Read reference files with the read tool and run scripts ` +
        'with bash ONLY when the instructions below ask for it.'
    )
  }
  if (args && !expanded.consumed) lines.push(`User arguments: ${args}`)
  lines.push('', '--- skill instructions ---', expanded.text)
  return lines.join('\n')
}

/** Catalog line (system prompt): name + description only — body arrives on demand. */
export function skillCatalogLine(skill: ChatSkill): string {
  return `- ${skill.name}: ${skill.description.replace(/\s+/g, ' ').trim() || '(no description)'}`
}

export type SkillOverride = 'on' | 'off'

// ---------- Creation / removal / installation (fs) ----------

/** Safe description for generated frontmatter: convert newlines to spaces (otherwise user-entered
 * multiline descriptions could inject fields/terminate frontmatter). */
function yamlSafeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim()
}

const SKILL_TEMPLATE = (name: string, description: string): string =>
  `---
name: ${name}
description: ${description || 'Describe WHEN the agent should use this skill (this text is what it sees).'}
# argument-hint: [arg]          # optional: hint shown in the / palette
# disable-model-invocation: true # optional: only the user can invoke it (with /${name})
# user-invocable: false          # optional: only the model can invoke it (via use_skill)
---

# ${name}

Write the instructions the agent must follow when this skill is triggered.

## Bundled resources (optional)

Create these folders next to this file and reference them from here — paths resolve from the skill folder:

- \`scripts/\` executable helpers the agent runs with bash
- \`references/\` extra docs the agent reads on demand
- \`assets/\` templates and boilerplate the agent copies
`

export interface SkillWriteResult {
  ok: boolean
  error?: string
  name?: string
  dir?: string
}

/** Creates skill folder EXCLUSIVELY (parent root may exist; skill folder must not). */
async function mkdirExclusive(root: string, dir: string): Promise<SkillWriteResult> {
  await fsp.mkdir(root, { recursive: true })
  try {
    await fsp.mkdir(dir, { recursive: false })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'already-exists' : String(e) }
  }
}

/** Creates skill skeleton (`<root>/<name>/SKILL.md`). Fails if folder exists. */
export async function createSkill(input: {
  name: string
  description?: string
  scope: ChatSkillScope
  cwd: string
  home?: string
}): Promise<SkillWriteResult> {
  const name = normalizeCommandName(input.name)
  if (!name) return { ok: false, error: 'invalid-name' }
  if (input.scope === 'project' && !input.cwd) return { ok: false, error: 'no-cwd' }
  const root = skillInstallRoot(input.scope, input.cwd, input.home ?? os.homedir())
  const dir = path.join(root, name)
  const created = await mkdirExclusive(root, dir)
  if (!created.ok) return created
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    SKILL_TEMPLATE(name, yamlSafeDescription(input.description ?? '')),
    'utf8'
  )
  return { ok: true, name, dir }
}

/** Removes a skill FOLDER. `dir` must be under a known skill root (guards arbitrary rm). */
export async function removeSkillDir(dir: string, cwd: string, home: string = os.homedir()): Promise<SkillWriteResult> {
  if (!dir) return { ok: false, error: 'invalid-input' }
  const roots = skillDirs(cwd, home).map((d) => path.resolve(d.dir))
  const target = path.resolve(dir)
  const inRoot = roots.some((root) => target.startsWith(root + path.sep) && path.dirname(target) === root)
  if (!inRoot) return { ok: false, error: 'outside-skill-roots' }
  await fsp.rm(target, { recursive: true, force: true })
  return { ok: true, dir: target }
}

/** Converts saved prompt text to a real skill (folder + SKILL.md using template body). */
export async function writeSkillFromPrompt(input: {
  name: string
  description?: string
  content: string
  scope: ChatSkillScope
  cwd: string
  home?: string
}): Promise<SkillWriteResult> {
  const name = normalizeCommandName(input.name)
  if (!name) return { ok: false, error: 'invalid-name' }
  const body = (input.content ?? '').trim()
  if (!body) return { ok: false, error: 'empty' }
  if (input.scope === 'project' && !input.cwd) return { ok: false, error: 'no-cwd' }
  const root = skillInstallRoot(input.scope, input.cwd, input.home ?? os.homedir())
  const dir = path.join(root, name)
  const created = await mkdirExclusive(root, dir)
  if (!created.ok) return created
  const description = yamlSafeDescription(input.description ?? '')
  const front = `---\nname: ${name}\ndescription: ${description || `Converted from the saved prompt /${name}.`}\n---\n\n`
  await fsp.writeFile(path.join(dir, 'SKILL.md'), front + body + '\n', 'utf8')
  return { ok: true, name, dir }
}
