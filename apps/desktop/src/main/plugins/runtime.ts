import { mkdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { normalizeSkillName } from '../../shared/chat'
import { normalizeSubagentProfileKey } from '../../shared/subagent-profiles'
import type { ChatAgent } from '../chat/agents'
import {
  type ChatSkill,
  parseSkillFrontmatter,
  readCappedSkillText,
  readSkillDirectory,
  SKILL_BODY_MAX_CHARS,
} from '../chat/skills'
import type { McpServer } from '../chat/mcp-types'
import { scopeAppliesTo } from '../chat/workspace-scope'
import { appPluginLayout } from './app-layout'
import { loadPluginPackage } from './formats/detect'
import { type PluginLayout, pluginKeyHash } from './layout'
import { fsPackageTree } from './package-tree'
import { hookDigest, launchDigest } from './consent'
import type { PluginHookSpec } from './hooks-scan'
import type { PluginInputSpec, PluginMcpServerSpec } from './mcp-normalize'
import { type InstalledPluginRecord, listInstalled, onInstalledChanged, readPluginSecrets } from './store'
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
const agentLists = new Map<string, Promise<ChatAgent[]>>()
onInstalledChanged(() => invalidatePluginRuntimeCache())

export function invalidatePluginRuntimeCache(key?: string): void {
  if (!key) {
    packages.clear()
    skillLists.clear()
    agentLists.clear()
    return
  }
  for (const map of [packages, skillLists, agentLists] as Map<string, unknown>[])
    for (const cacheKey of [...map.keys()]) if (cacheKey.startsWith(`${key}\0`)) map.delete(cacheKey)
}

export function pluginAppliesTo(record: InstalledPluginRecord, ctx: PluginRuntimeContext): boolean {
  if (!record.enabled || record.status !== 'ready' || record.blocked?.length) return false
  return scopeAppliesTo(record.scope, ctx.conversationId)
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

/**
 * A plugin's agents as subagents named `<plugin>-<agent>`. They carry no model of their own: they run on the parent's
 * model unless a subagent rule chooses another, so they behave the same with every provider.
 */
async function buildPluginAgents(record: InstalledPluginRecord, layout: PluginLayout): Promise<ChatAgent[]> {
  const pkg = await loadInstalledPackage(record, layout)
  if (!pkg) return []
  const root = installedPackageDir(record, layout)
  const displayName = displayNameOf(record, pkg)
  const out: ChatAgent[] = []
  for (const spec of pkg.agents) {
    const name = normalizeSubagentProfileKey(`${pkg.name}-${spec.name}`)
    const raw = await readCappedSkillText(path.join(root, ...spec.filePath.split('/')))
    if (!name || !raw) continue
    const prompt = parseSkillFrontmatter(raw.text).body.trim()
    if (!prompt) continue
    const truncated = raw.clipped || prompt.length > SKILL_BODY_MAX_CHARS
    out.push({
      name,
      description: spec.description,
      ...(spec.tools?.length ? { tools: spec.tools } : {}),
      prompt: truncated ? `${prompt.slice(0, SKILL_BODY_MAX_CHARS)}\n… (truncated)` : prompt,
      source: `plugin:${displayName}/${spec.filePath}`,
    })
  }
  return out
}

/** Agents of the plugins active in a context, as subagents; the first plugin (by key) keeps a repeated name. */
export async function listPluginAgents(
  ctx: PluginRuntimeContext,
  layout: PluginLayout = appPluginLayout()
): Promise<ChatAgent[]> {
  const lists = await Promise.all(
    activePlugins(ctx).map((record) => {
      const cacheKey = `${record.key}\0${record.dirName}`
      let pending = agentLists.get(cacheKey)
      if (!pending) {
        pending = buildPluginAgents(record, layout).catch(() => [])
        agentLists.set(cacheKey, pending)
      }
      return pending
    })
  )
  const seen = new Set<string>()
  return lists.flat().filter((agent) => !seen.has(agent.name) && (seen.add(agent.name), true))
}

/** A hook of an active plugin, ready to run: its command and environment with the plugin's folders filled in. */
export interface ActivePluginHook {
  pluginKey: string
  pluginName: string
  spec: PluginHookSpec
  command: string
  env: Record<string, string>
}

/**
 * Hooks of the plugins active in a context whose current hooks the person approved (`consent.hooks` is the digest of
 * exactly these hooks). Hooks run with the plugin's folders in `PLUGIN_ROOT`/`PLUGIN_DATA` and their Claude Code names.
 */
export function listPluginHooks(
  ctx: PluginRuntimeContext,
  layout: PluginLayout = appPluginLayout()
): ActivePluginHook[] {
  const out: ActivePluginHook[] = []
  for (const record of activePlugins(ctx)) {
    const hooks = record.hooks ?? []
    if (!hooks.length || !record.consent.hooks || record.consent.hooks !== hookDigest(hooks)) continue
    const root = installedPackageDir(record, layout)
    const data = layout.data(pluginKeyHash(record.key))
    const env = { PLUGIN_ROOT: root, PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data }
    const expand = (value: string) =>
      value.replace(/\$\{(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|PLUGIN_DATA)\}/g, (_, name: string) =>
        name.endsWith('ROOT') ? root : data
      )
    for (const spec of hooks)
      out.push({
        pluginKey: record.key,
        pluginName: record.displayName ?? record.name,
        spec,
        command: expand(spec.command),
        env,
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
  const byName = new Map<string, ChatSkill>()
  for (const skill of lists.flat()) if (!byName.has(skill.name)) byName.set(skill.name, skill)
  return [...byName.values()]
}

// ---------------------------------------------------------------- MCP servers

const PLACEHOLDER = /\$\{(PLUGIN_ROOT|PLUGIN_DATA|input:[^}]+)\}/g
const INPUT_REFERENCE = /\$\{input:([^}]+)\}/g

/** Display name of a plugin MCP server: the plugin's name, or `<plugin>-<server>` when they differ. */
export function pluginServerName(record: InstalledPluginRecord, serverKey: string): string {
  return serverKey === record.name ? serverKey : `${record.name}-${serverKey}`
}

function referencedInputs(spec: PluginMcpServerSpec): Set<string> {
  const values =
    spec.transport === 'stdio'
      ? [...spec.args, ...Object.values(spec.env), spec.cwd]
      : [spec.url, ...Object.values(spec.headers)]
  const ids = new Set<string>()
  for (const value of values) for (const match of value.matchAll(INPUT_REFERENCE)) ids.add(match[1])
  return ids
}

/** Inputs that feed one server: its own env/header inputs and the options its configuration references. */
export function serverInputs(record: InstalledPluginRecord, spec: PluginMcpServerSpec): PluginInputSpec[] {
  const referenced = referencedInputs(spec)
  return (record.inputs ?? []).filter((input) =>
    input.target.kind === 'config'
      ? referenced.has(input.id)
      : input.target.serverKey === spec.key || referenced.has(input.id)
  )
}

const isInside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function validRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(url.hostname)
  } catch {
    return false
  }
}

/**
 * Plugin MCP servers as `McpServer` entries, expanded for this host: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` become the
 * installed version and its data directory, `${input:…}` the user's values (once, never recursively). A stdio server
 * is enabled only while its exact launch line has the user's consent; missing or unreadable required inputs make a
 * server unavailable, never connected.
 */
export function listPluginMcpServers(
  ctx: PluginRuntimeContext,
  opts: { includeInactive?: boolean } = {},
  layout: PluginLayout = appPluginLayout()
): McpServer[] {
  const out: McpServer[] = []
  const records = Object.values(listInstalled())
    .filter((record) => record.status === 'ready')
    .sort((a, b) => a.key.localeCompare(b.key))
  for (const record of records) {
    const active = pluginAppliesTo(record, ctx)
    if (!active && !opts.includeInactive) continue
    const root = installedPackageDir(record, layout)
    const data = layout.data(pluginKeyHash(record.key))
    const secrets = (record.inputs ?? []).length ? readPluginSecrets(record.key) : {}
    for (const spec of record.mcpServers ?? []) {
      const state = record.servers[spec.key]
      if (!state) continue
      const consented = spec.transport !== 'stdio' || record.consent.stdio[spec.key] === launchDigest(spec)
      const inputs = serverInputs(record, spec)
      const inputValue = (id: string): string | undefined => {
        const stored = secrets?.[id]
        if (stored !== undefined && stored !== '') return stored
        return inputs.find((input) => input.id === id)?.defaultValue ?? undefined
      }
      let unavailable = secrets === null || inputs.some((input) => input.required && !inputValue(input.id))
      const expand = (value: string): string =>
        value.replace(PLACEHOLDER, (_, name: string) =>
          name === 'PLUGIN_ROOT'
            ? root
            : name === 'PLUGIN_DATA'
              ? data
              : (inputValue(name.slice('input:'.length)) ?? '')
        )
      const server: McpServer = {
        id: state.id,
        name: pluginServerName(record, spec.key),
        transport: spec.transport,
        enabled: state.enabled && active && consented,
        origin: {
          kind: 'plugin',
          pluginKey: record.key,
          pluginName: record.displayName ?? record.name,
          serverKey: spec.key,
        },
        ...(spec.startupTimeoutMs ? { startupTimeoutMs: spec.startupTimeoutMs } : {}),
        ...(spec.toolTimeoutMs ? { toolTimeoutMs: spec.toolTimeoutMs } : {}),
        ...(spec.toolFilter ? { toolFilter: spec.toolFilter } : {}),
        ...(spec.auth.kind === 'oauth'
          ? {
              oauth: {
                ...(spec.auth.scopes?.length ? { scopes: spec.auth.scopes } : {}),
                ...(spec.auth.resource ? { resource: spec.auth.resource } : {}),
              },
            }
          : {}),
      }
      if (spec.transport === 'stdio') {
        try {
          let command = spec.command
          if (spec.commandKind === 'plugin-relative') {
            command = path.join(root, ...spec.command.slice(2).split('/'))
            const real = realpathSync(command)
            if (!isInside(realpathSync(root), real) || !statSync(real).isFile()) throw new Error('path-unsafe')
          }
          const cwdValue = expand(
            spec.cwd === './' ? root : spec.cwd.startsWith('./') ? path.join(root, spec.cwd.slice(2)) : spec.cwd
          )
          const cwd = path.resolve(cwdValue)
          if (!isInside(root, cwd) && !isInside(data, cwd)) throw new Error('path-unsafe')
          if (isInside(data, cwd)) mkdirSync(cwd, { recursive: true })
          const env: Record<string, string> = {}
          for (const [name, value] of Object.entries(spec.env)) env[name] = expand(value)
          for (const input of inputs) {
            if (input.target.kind !== 'env' || input.target.serverKey !== spec.key) continue
            const value = inputValue(input.id)
            if (value !== undefined && value !== '') env[input.target.name] = value
          }
          env.PLUGIN_ROOT = root
          env.PLUGIN_DATA = data
          if (record.format === 'claude') {
            env.CLAUDE_PLUGIN_ROOT = root
            env.CLAUDE_PLUGIN_DATA = data
          }
          Object.assign(server, { command, args: spec.args.map(expand), env, cwd })
        } catch {
          unavailable = true
        }
      } else {
        const url = expand(spec.url)
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(spec.headers)) headers[name] = expand(value)
        for (const input of inputs) {
          if (input.target.kind !== 'header' || input.target.serverKey !== spec.key) continue
          const value = inputValue(input.id)
          if (value !== undefined && value !== '') headers[input.target.name] = `${input.target.prefix}${value}`
        }
        if (!validRemoteUrl(url)) unavailable = true
        Object.assign(server, { url, headers })
      }
      out.push(unavailable ? { ...server, unavailable: true } : server)
    }
  }
  return out
}
