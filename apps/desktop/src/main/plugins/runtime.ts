import path from 'node:path'
import { normalizeSkillName } from '../../shared/chat'
import {
  type ChatSkill,
  parseSkillFrontmatter,
  readCappedSkillText,
  readSkillDirectory,
  SKILL_BODY_MAX_CHARS,
} from '../chat/skills'
import { getConversation } from '../store'
import { appPluginLayout } from './app-layout'
import { loadPluginPackage } from './formats/detect'
import { type PluginLayout, pluginKeyHash } from './layout'
import { fsPackageTree } from './package-tree'
import { type InstalledPluginRecord, listInstalled, onInstalledChanged } from './store'
import type { PluginPackage } from './types'

/**
 * Which installed plugins apply to a conversation, and what they contribute. Plugins reach every provider through
 * Maestrly's own skill catalog and MCP proxy; nothing here is provider-specific.
 */

export interface PluginRuntimeContext {
  /** undefined = Settings (every enabled plugin); null = no conversation (global plugins only). */
  conversationId?: string | null
}

const packages = new Map<string, Promise<PluginPackage | null>>()
const skillLists = new Map<string, Promise<ChatSkill[]>>()
onInstalledChanged(() => invalidatePluginRuntimeCache())

export function invalidatePluginRuntimeCache(key?: string): void {
  if (!key) {
    packages.clear()
    skillLists.clear()
    return
  }
  for (const map of [packages, skillLists] as Map<string, unknown>[])
    for (const cacheKey of [...map.keys()]) if (cacheKey.startsWith(`${key}\0`)) map.delete(cacheKey)
}

/** Workspaces of a project conversation (every repository of a multi-repository one); none for standalone chats. */
function conversationWorkspaces(conversationId: string | null | undefined): string[] {
  if (!conversationId) return []
  const conversation = getConversation(conversationId)
  if (!conversation || conversation.scope === 'standalone') return []
  return [conversation.workspaceId, ...(conversation.repos ?? []).map((repo) => repo.workspaceId)]
}

export function pluginAppliesTo(record: InstalledPluginRecord, ctx: PluginRuntimeContext): boolean {
  if (!record.enabled || record.status !== 'ready') return false
  if (ctx.conversationId === undefined || record.scope.kind === 'global') return true
  const scoped = record.scope.workspaceIds
  return conversationWorkspaces(ctx.conversationId).some((id) => scoped.includes(id))
}

export function activePlugins(ctx: PluginRuntimeContext): InstalledPluginRecord[] {
  return Object.values(listInstalled())
    .filter((record) => pluginAppliesTo(record, ctx))
    .sort((a, b) => a.key.localeCompare(b.key))
}

export function installedPackageDir(record: InstalledPluginRecord, layout: PluginLayout = appPluginLayout()): string {
  return layout.packageDir(pluginKeyHash(record.key), record.dirName)
}

/** The installed version's package, loaded once per version. */
export function loadInstalledPackage(
  record: InstalledPluginRecord,
  layout: PluginLayout = appPluginLayout()
): Promise<PluginPackage | null> {
  const cacheKey = `${record.key}\0${record.dirName}`
  let pending = packages.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const tree = await fsPackageTree(installedPackageDir(record, layout))
      const result = await loadPluginPackage(tree, record.loadOptions ?? {})
      return result.ok ? result.pkg : null
    })().catch(() => null)
    packages.set(cacheKey, pending)
  }
  return pending
}

const displayNameOf = (record: InstalledPluginRecord, pkg: PluginPackage): string =>
  record.displayName ?? pkg.displayName ?? pkg.name

async function buildPluginSkills(record: InstalledPluginRecord, layout: PluginLayout): Promise<ChatSkill[]> {
  const pkg = await loadInstalledPackage(record, layout)
  if (!pkg) return []
  const root = installedPackageDir(record, layout)
  const displayName = displayNameOf(record, pkg)
  const out: ChatSkill[] = []
  for (const spec of pkg.skills) {
    const name = normalizeSkillName(`${pkg.name}:${spec.name}`)
    const plugin = { key: record.key, displayName, kind: spec.kind }
    const source = `plugin:${displayName}/${spec.dirPath || (spec.kind === 'skill' ? 'SKILL.md' : spec.name)}`
    if (spec.kind === 'skill') {
      const abs = spec.dirPath ? path.join(root, ...spec.dirPath.split('/')) : root
      const skill = await readSkillDirectory(path.dirname(abs), path.basename(abs), 'plugin', 'plugin')
      if (skill) out.push({ ...skill, name, source, scope: 'plugin', plugin })
      continue
    }
    let text: string | null = spec.inlineBody ?? null
    let clipped = false
    if (text === null && spec.dirPath) {
      const raw = await readCappedSkillText(path.join(root, ...spec.dirPath.split('/')))
      if (!raw) continue
      text = raw.text
      clipped = raw.clipped
    }
    if (text === null) continue
    const { fields, body } = parseSkillFrontmatter(text)
    const content = body.trim()
    if (!content) continue
    const truncated = clipped || content.length > SKILL_BODY_MAX_CHARS
    out.push({
      name,
      description: spec.description,
      body: truncated ? `${content.slice(0, SKILL_BODY_MAX_CHARS)}\n… (truncated)` : content,
      source,
      dir: spec.dirPath ? path.dirname(path.join(root, ...spec.dirPath.split('/'))) : root,
      scope: 'plugin',
      ...(fields['argument-hint'] ? { argumentHint: fields['argument-hint'] } : {}),
      modelInvocable: false,
      userInvocable: true,
      resources: [],
      ...(truncated ? { truncated: true } : {}),
      plugin,
    })
  }
  return out
}

/** Skills and commands of the plugins active in a context, namespaced `<plugin>:<name>`. */
export async function listPluginSkills(
  ctx: PluginRuntimeContext,
  layout: PluginLayout = appPluginLayout()
): Promise<ChatSkill[]> {
  const lists = await Promise.all(
    activePlugins(ctx).map((record) => {
      const cacheKey = `${record.key}\0${record.dirName}`
      let pending = skillLists.get(cacheKey)
      if (!pending) {
        pending = buildPluginSkills(record, layout).catch(() => [])
        skillLists.set(cacheKey, pending)
      }
      return pending
    })
  )
  const seen = new Set<string>()
  return lists.flat().filter((skill) => (seen.has(skill.name) ? false : (seen.add(skill.name), true)))
}
