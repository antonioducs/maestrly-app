import { normalizeCommandName } from '../chat/commands'
import { parseSkillFrontmatter } from '../chat/skills'
import type { PackageTree } from './package-tree'

/** A plugin agent adapted to a Maestrly subagent that every model can run. */
export interface PluginAgentSpec {
  /** Un-namespaced name (frontmatter `name` or the file name), 1–64 characters. */
  name: string
  /** Tree path of the Markdown file. */
  filePath: string
  description: string
  /** Maestrly tool names; null = the default subagent set (read-only). */
  tools: string[] | null
  /** Tools the agent names that have no equivalent every model can use. */
  droppedTools: string[]
}
export interface AgentScanIssue {
  code: 'agent-invalid'
  path: string
  detail: string
}

/**
 * Claude Code (and Codex) tool names → Maestrly tools; null = no portable equivalent. Delegation and planning tools
 * are dropped: a subagent never delegates or keeps the parent's to-do list. `mcp__*` tools become generic access to the
 * enabled MCP servers, the plugin's own included.
 */
export const AGENT_TOOL_MAP: Record<string, string | null> = {
  Read: 'read',
  Grep: 'grep',
  Glob: 'glob',
  LS: 'glob',
  Bash: 'bash',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  WebFetch: 'webfetch',
  WebSearch: 'web_search',
  NotebookRead: 'read',
  TodoWrite: null,
  Task: null,
  Agent: null,
  NotebookEdit: null,
}
/** Maestrly's own names, accepted as written (lowercase) by agents made for Maestrly or Codex. */
const MAESTRLY_TOOLS = new Set(['read', 'grep', 'glob', 'bash', 'edit', 'write', 'webfetch', 'web_search'])
const AGENT_TEXT_MAX_BYTES = 1024 * 1024

/** Immediate `*.md` children of agent folders, or listed Markdown files. */
export function agentFiles(tree: PackageTree, sources: readonly string[]): string[] {
  const files = new Set<string>()
  for (const source of sources) {
    if (/\.md$/i.test(source)) {
      const entry = tree.entries.get(source)
      if (entry?.mode === 'file' || entry?.mode === 'executable') files.add(source)
      continue
    }
    const prefix = source ? `${source}/` : ''
    for (const key of tree.entries.keys()) {
      const rel = key.slice(prefix.length)
      if (key.startsWith(prefix) && !rel.includes('/') && /\.md$/i.test(rel) && !/\.md\.tmpl$/i.test(rel))
        files.add(key)
    }
  }
  return [...files].sort()
}

/** The `tools` of a frontmatter: `A, B`, `[A, B]`, or a YAML list under the key. Empty when absent. */
function toolNames(frontmatter: string, value: string | undefined): string[] | null {
  if (value)
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => item.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  const lines = frontmatter.split(/\r?\n/)
  const start = lines.findIndex((line) => /^tools:\s*$/i.test(line))
  if (start < 0) return null
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.+)$/.exec(line)
    if (!item) break
    items.push(item[1].trim().replace(/^["']|["']$/g, ''))
  }
  return items
}

/** Maps named tools to Maestrly's; `null` when the agent names none (it gets the default set). */
function mapTools(names: string[] | null): { tools: string[] | null; dropped: string[] } {
  if (names === null || !names.length) return { tools: null, dropped: [] }
  const tools = new Set<string>()
  const dropped: string[] = []
  for (const name of names) {
    if (name.startsWith('mcp__')) {
      tools.add('mcp_search')
      tools.add('mcp_call')
      continue
    }
    const mapped = name in AGENT_TOOL_MAP ? AGENT_TOOL_MAP[name] : MAESTRLY_TOOLS.has(name) ? name : null
    if (mapped) tools.add(mapped)
    else if (!dropped.includes(name)) dropped.push(name)
  }
  return { tools: tools.size ? [...tools] : null, dropped }
}

/**
 * Reads the Markdown agents of a plugin. Each needs a description and a body (its system prompt). `model` is ignored:
 * a plugin agent runs on the parent's model unless a subagent rule in Settings chooses another.
 */
export async function scanAgents(
  tree: PackageTree,
  sources: readonly string[]
): Promise<{ agents: PluginAgentSpec[]; issues: AgentScanIssue[] }> {
  const agents: PluginAgentSpec[] = []
  const issues: AgentScanIssue[] = []
  const seen = new Set<string>()
  for (const filePath of agentFiles(tree, sources)) {
    const raw = await tree.read(filePath, AGENT_TEXT_MAX_BYTES)
    if (!raw) {
      issues.push({ code: 'agent-invalid', path: filePath, detail: 'the agent file is unreadable or too large' })
      continue
    }
    const text = raw.toString('utf8')
    const { fields, body } = parseSkillFrontmatter(text)
    const stem = filePath.split('/').pop()!.replace(/\.md$/i, '')
    const name = normalizeCommandName(fields.name || stem)
    const description = (fields.description ?? '').trim()
    if (!name || name.length > 64) {
      issues.push({ code: 'agent-invalid', path: filePath, detail: 'the agent name must have 1 to 64 characters' })
      continue
    }
    if (!description || !body.trim()) {
      issues.push({ code: 'agent-invalid', path: filePath, detail: 'an agent needs a description and a prompt' })
      continue
    }
    if (seen.has(name)) {
      issues.push({ code: 'agent-invalid', path: filePath, detail: `another agent is named "${name}"` })
      continue
    }
    seen.add(name)
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
    const { tools, dropped } = mapTools(toolNames(frontmatter, fields.tools))
    agents.push({ name, filePath, description, tools, droppedTools: dropped })
  }
  return { agents, issues }
}
