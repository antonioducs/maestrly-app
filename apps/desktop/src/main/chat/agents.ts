/**
 * BYOK chat subagents — conceptually ported from opencode "agents" (.opencode/agents) and
 * Claude Code subagents (.claude/agents/<name>.md). Each subagent is a .md file with `name`/`description`
 * frontmatter (optional `model`, `tools`) and a system-prompt body. The PARENT delegates a subtask via `task`
 * (see runner): a synchronous ISOLATED sub-run (own history, agent system prompt, tool subset, no `task` →
 * prevents recursion) returns text. Reads project (cwd) AND global (~) definitions, like skills.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isRealSubagentProfileEffort } from '../../shared/subagent-profile-effort'
import {
  normalizeSubagentProfileKey,
  type SubagentAgentDto,
  type SubagentProfileCandidate,
  type SubagentProfileDiagnostic,
} from '../../shared/subagent-profiles'
import { ALL_TOOL_NAMES } from './tools'

// "Worker" (general-purpose) tools: everything EXCEPT interactive/meta tools (ask_question requires interaction;
// todo_write organizes the PARENT; task never enters subagents → prevents recursion). Includes bash/write/edit and
// the host generate_image tool; runners retain it only if the parent supplied it and the child can mutate.
const WORKER_TOOLS = ALL_TOOL_NAMES.filter((name) => name !== 'ask_question' && name !== 'todo_write')

export interface ChatAgent {
  name: string
  description: string
  category?: string
  /** Raw scalar fields retained for frontmatter compatibility/diagnostics. */
  provider?: string
  model?: string
  effort?: string
  /** Complete layer-7 candidate. `undefined` for inherit, legacy, and incomplete frontmatter. */
  profile?: SubagentProfileCandidate
  /** Legacy model-only selection: resolver combines it with the parent profile's provider/effort. */
  legacyModel?: string
  profileDiagnostics?: SubagentProfileDiagnostic[]
  /** Allowed tool names (lowercase); absent = read-only subset by default. */
  tools?: string[]
  /** Subagent system prompt (.md body). */
  prompt: string
  source: string
  /** Virtual agent (V1): executable alias from a custom `byAgent` key (no .md file). */
  virtual?: boolean
  /** Physical agent providing the virtual agent's behavior/tools (V1: always general-purpose). */
  baseAgentName?: string
}

const MAX_PROMPT = 16000

/**
 * BUILT-IN subagents (always available, no file required). Mirror Claude Code/opencode
 * (general-purpose + explore), deliberately READ-ONLY: chat subagents INVESTIGATE and return
 * answers — the PARENT edits (user reviews). This activates the `task` tool so the
 * model can offload heavy searching/reading into isolated context (saving conversation context/cost).
 * A project/global agent with the same name OVERRIDES the built-in (user customization).
 * Exported for the effective-agent layer (virtual-subagents), which uses general-purpose as
 * the virtual agents' behavior/tool base when no custom physical definition exists.
 */
export const BUILTIN_AGENTS: ChatAgent[] = [
  {
    name: 'explore',
    category: 'exploration',
    description:
      'Read-only search agent for broad sweeps — locate code, files or "where/which/how-many" answers across many files and report back the findings (no edits). Use it to investigate without filling your context with raw file dumps.',
    prompt:
      'You are a read-only exploration subagent. Investigate the codebase to answer the task using ONLY read/search tools — never edit files or run state-changing commands (you do not have those tools). Search broadly and follow leads across files. Return a concise, structured answer: the concrete findings as `path:line`, the key snippets that matter, and the conclusion. Do not dump whole files — report only what is relevant to the task.',
    source: 'built-in',
  },
  {
    name: 'general-purpose',
    category: 'implementation',
    description:
      'Worker agent with FULL tools (read/search/edit/run) for implementing a self-contained slice of a larger task. Delegate a well-scoped piece (e.g. "implement module X", "migrate the callers of Y") and it carries it out end to end — reading, editing, running tests — in its own context, returning a summary of what it changed. Decompose big tasks into such slices and delegate each.',
    tools: WORKER_TOOLS,
    prompt:
      'You are a worker subagent with full tools (read, search, edit, run commands). Carry out the assigned subtask end to end in your own context: read what you need, make the changes, and verify they work (run the test/build when you can). You do NOT see the parent conversation — work only from the task you were given; if it is underspecified, make the most reasonable decision and note it. Follow the existing conventions of the code you touch and keep the change minimal. Return a concise summary: what you changed (files as `path:line`), what you verified, and anything the parent needs to know (decisions, follow-ups, failures). Report results faithfully — never claim success you did not verify.',
    source: 'built-in',
  },
]

function agentDirs(cwd: string, home: string): { dir: string; label: string }[] {
  const list = [
    { dir: path.join(cwd, '.claude/agents'), label: '.claude/agents' },
    { dir: path.join(cwd, '.agents/agents'), label: '.agents/agents' },
    { dir: path.join(home, '.claude/agents'), label: '~/.claude/agents' },
    { dir: path.join(home, '.agents/agents'), label: '~/.agents/agents' },
  ]
  const seen = new Set<string>()
  return list.filter((x) => {
    if (seen.has(x.dir)) return false
    seen.add(x.dir)
    return true
  })
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fm: {}, body: text }
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.+)$/.exec(line)
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { fm, body: text.slice(m[0].length) }
}

/** Lists project + global subagents. .md files; accepts symlinks. Deduplicates by name (project wins). */
export async function listAgents(cwd: string, home: string = os.homedir()): Promise<ChatAgent[]> {
  if (!cwd) return []
  const out: ChatAgent[] = []
  const seen = new Set<string>()
  for (const { dir, label } of agentDirs(cwd, home)) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || !/\.md$/i.test(e.name) || (!e.isFile() && !e.isSymbolicLink())) continue
      try {
        const raw = await fsp.readFile(path.join(dir, e.name), 'utf8')
        const { fm, body } = parseFrontmatter(raw)
        const name = normalizeSubagentProfileKey(fm.name || e.name.replace(/\.md$/i, ''))
        const prompt = body.trim()
        if (!name || seen.has(name) || !prompt) continue
        const tools = fm.tools
          ? fm.tools
              .split(',')
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean)
          : undefined
        const provider = fm.provider?.trim() || undefined
        const model = fm.model?.trim() || undefined
        const effort = fm.effort?.trim().toLowerCase() || undefined
        const completeProfile = provider && model && model.toLowerCase() !== 'inherit' && effort
        const invalidEffort = completeProfile && !isRealSubagentProfileEffort(effort)
        const incompleteProfile = (provider || effort) && !completeProfile
        const profileDiagnostics: SubagentProfileDiagnostic[] | undefined = invalidEffort
          ? [
              {
                code: 'invalid-effort',
                severity: 'warning',
                message: 'Frontmatter profile requires a real reasoning effort.',
              },
            ]
          : incompleteProfile
            ? [
                {
                  code: 'incomplete-frontmatter',
                  severity: 'warning',
                  message: 'Frontmatter profile requires provider, model and effort.',
                },
              ]
            : undefined
        out.push({
          name,
          description: (fm.description || '').trim(),
          category: fm.category ? normalizeSubagentProfileKey(fm.category) || undefined : undefined,
          provider,
          model,
          effort,
          profile: completeProfile && !invalidEffort ? { providerId: provider, modelId: model, effort } : undefined,
          legacyModel: model && model.toLowerCase() !== 'inherit' && !provider && !effort ? model : undefined,
          profileDiagnostics,
          tools: tools?.length ? tools : undefined,
          prompt: prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + '\n… (truncated)' : prompt,
          source: `${label}/${e.name}`,
        })
        seen.add(name)
      } catch {
        /* Unreadable file → skip. */
      }
    }
  }
  // Built-ins last: include only if the user has NOT defined that name (project/global win).
  for (const a of BUILTIN_AGENTS) {
    if (!seen.has(a.name)) {
      out.push(a)
      seen.add(a.name)
    }
  }
  return out
}

export function agentToDto(agent: ChatAgent): SubagentAgentDto {
  return {
    name: agent.name,
    description: agent.description,
    ...(agent.category ? { category: agent.category } : {}),
    source: agent.source,
    ...(agent.virtual ? { virtual: true, baseAgentName: agent.baseAgentName ?? 'general-purpose' } : {}),
  }
}

/** Looks up a subagent by normalized name. null if absent. */
export async function getAgent(cwd: string, name: string, home: string = os.homedir()): Promise<ChatAgent | null> {
  const norm = normalizeSubagentProfileKey(name)
  if (!norm) return null
  return (await listAgents(cwd, home)).find((a) => a.name === norm) ?? null
}
