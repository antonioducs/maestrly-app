import { normalizeCommandName } from '../chat/commands'
import { parseSkillFrontmatter } from '../chat/skills'
import type { PackageTree } from './package-tree'

export interface PluginSkillSpec {
  /** Un-namespaced name; the runtime exposes it as `<plugin>:<name>`. */
  name: string
  /** Tree path of the skill folder (skills) or of the Markdown file (commands). `''` is the plugin root. */
  dirPath: string
  description: string
  kind: 'skill' | 'command'
  hasScripts: boolean
  /** Inline Markdown body of a command declared in a manifest map (Claude `commands.<name>.content`). */
  inlineBody?: string
}
export interface ScanIssue {
  code: 'skill-invalid' | 'command-invalid'
  path: string
  detail: string
}

/** Agent Skills name: lowercase alphanumerics with single hyphens, 1–64 characters. */
export const AGENT_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_TEXT_MAX_BYTES = 1024 * 1024

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)
const basename = (p: string): string => p.split('/').pop() ?? p

function hasScripts(tree: PackageTree, dirPath: string): boolean {
  const prefix = dirPath ? `${dirPath}/` : ''
  for (const [key, entry] of tree.entries) {
    if (!key.startsWith(prefix)) continue
    const rel = key.slice(prefix.length)
    if (entry.mode === 'executable' || rel.startsWith('scripts/')) return true
  }
  return false
}

/** Immediate child folders of `root` that list a `SKILL.md` entry. */
function childSkillFolders(tree: PackageTree, root: string): string[] {
  const prefix = root ? `${root}/` : ''
  const folders = new Set<string>()
  for (const key of tree.entries.keys()) {
    if (!key.startsWith(prefix)) continue
    const parts = key.slice(prefix.length).split('/')
    if (parts.length === 2 && parts[1] === 'SKILL.md') folders.add(join(root, parts[0]))
  }
  return [...folders].sort()
}

async function readSkill(
  tree: PackageTree,
  dirPath: string,
  folderName: string,
  strict: boolean,
  issues: ScanIssue[]
): Promise<PluginSkillSpec | null> {
  const file = join(dirPath, 'SKILL.md')
  const entry = tree.entries.get(file)
  if (entry && entry.mode !== 'file' && entry.mode !== 'executable') {
    issues.push({ code: 'skill-invalid', path: file, detail: 'SKILL.md is not a regular file' })
    return null
  }
  const raw = await tree.read(file, SKILL_TEXT_MAX_BYTES)
  if (!raw) {
    issues.push({ code: 'skill-invalid', path: file, detail: 'SKILL.md is missing, unreadable, or too large' })
    return null
  }
  const { fields, body } = parseSkillFrontmatter(raw.toString('utf8'))
  const description = (fields.description ?? '').trim()
  if (strict) {
    const name = (fields.name ?? '').trim()
    if (!name || name.length > 64 || !AGENT_SKILL_NAME.test(name)) {
      issues.push({ code: 'skill-invalid', path: file, detail: 'name must be lowercase letters, digits and hyphens' })
      return null
    }
    if (name !== folderName) {
      issues.push({ code: 'skill-invalid', path: file, detail: `name "${name}" does not match its folder` })
      return null
    }
    if (!description || description.length > 1024) {
      issues.push({ code: 'skill-invalid', path: file, detail: 'description is required (at most 1024 characters)' })
      return null
    }
    if (!body.trim()) {
      issues.push({ code: 'skill-invalid', path: file, detail: 'the skill has no instructions' })
      return null
    }
    return { name, dirPath, description, kind: 'skill', hasScripts: hasScripts(tree, dirPath) }
  }
  const name = normalizeCommandName(fields.name || folderName)
  if (!name || !body.trim()) {
    issues.push({ code: 'skill-invalid', path: file, detail: 'the skill has no name or no instructions' })
    return null
  }
  // Bounded like an Agent Skills name, so `<plugin>:<skill>` fits every list that carries skill names.
  if (name.length > 64) {
    issues.push({ code: 'skill-invalid', path: file, detail: 'name longer than 64 characters' })
    return null
  }
  if (!description) issues.push({ code: 'skill-invalid', path: file, detail: 'description is missing' })
  return { name, dirPath, description, kind: 'skill', hasScripts: hasScripts(tree, dirPath) }
}

/**
 * Skills under each root: the root itself when it holds `SKILL.md`, otherwise its immediate children holding one
 * (Agent Plugins §7.1 never searches deeper). Duplicate names keep the first skill found.
 */
export async function scanSkills(
  tree: PackageTree,
  roots: readonly string[],
  opts: { strictAgentSkills: boolean; rootName?: string }
): Promise<{ skills: PluginSkillSpec[]; issues: ScanIssue[] }> {
  const skills: PluginSkillSpec[] = []
  const issues: ScanIssue[] = []
  const seen = new Set<string>()
  const add = (skill: PluginSkillSpec | null) => {
    if (!skill) return
    if (seen.has(skill.name)) {
      issues.push({ code: 'skill-invalid', path: join(skill.dirPath, 'SKILL.md'), detail: 'duplicate skill name' })
      return
    }
    seen.add(skill.name)
    skills.push(skill)
  }
  for (const root of roots) {
    if (tree.entries.has(join(root, 'SKILL.md'))) {
      const folderName = root ? basename(root) : (opts.rootName ?? '')
      add(await readSkill(tree, root, folderName, opts.strictAgentSkills, issues))
      continue
    }
    for (const folder of childSkillFolders(tree, root))
      add(await readSkill(tree, folder, basename(folder), opts.strictAgentSkills, issues))
  }
  return { skills, issues }
}

/** Markdown command files (a directory's immediate `*.md` children, or single files) as user-invocable skills. */
export async function scanCommands(
  tree: PackageTree,
  sources: readonly string[]
): Promise<{ skills: PluginSkillSpec[]; issues: ScanIssue[] }> {
  const files: string[] = []
  for (const source of sources) {
    if (/\.md$/i.test(source)) {
      if (tree.entries.has(source)) files.push(source)
      continue
    }
    const prefix = source ? `${source}/` : ''
    for (const key of [...tree.entries.keys()].sort()) {
      if (!key.startsWith(prefix)) continue
      const rel = key.slice(prefix.length)
      if (!rel.includes('/') && /\.md$/i.test(rel)) files.push(key)
    }
  }
  const skills: PluginSkillSpec[] = []
  const issues: ScanIssue[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const raw = await tree.read(file, SKILL_TEXT_MAX_BYTES)
    if (!raw) {
      issues.push({ code: 'command-invalid', path: file, detail: 'unreadable, too large, or not a regular file' })
      continue
    }
    const { fields, body } = parseSkillFrontmatter(raw.toString('utf8'))
    const description = (fields.description ?? '').trim()
    const name = normalizeCommandName(fields.name || basename(file).replace(/\.md$/i, ''))
    if (!description) {
      issues.push({ code: 'command-invalid', path: file, detail: 'description is required' })
      continue
    }
    if (!name || !body.trim() || seen.has(name)) {
      issues.push({ code: 'command-invalid', path: file, detail: 'missing or duplicate name, or empty body' })
      continue
    }
    // Bounded like an Agent Skills name, so `<plugin>:<command>` fits every list that carries skill names.
    if (name.length > 64) {
      issues.push({ code: 'command-invalid', path: file, detail: 'name longer than 64 characters' })
      continue
    }
    seen.add(name)
    skills.push({ name, dirPath: file, description, kind: 'command', hasScripts: false })
  }
  return { skills, issues }
}
