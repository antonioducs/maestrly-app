/**
 * Canonical project conventions context for ALL chat runtimes. Maestrly discovers one file
 * per directory from workspace/repo root to cwd, with identical precedence across providers:
 * AGENTS.override.md > AGENTS.md > CLAUDE.md (fallback). Durable memories remain transient and
 * do not enter this stable/cacheable prefix.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getWorkspace } from '../store'

const PROJECT_INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']
const PROJECT_INSTRUCTION_BYTES = 32 * 1024
const BYTE_TRUNCATION_SUFFIX = '\n… (truncated)'

async function readFileTrimmed(file: string): Promise<string> {
  try {
    return (await fsp.readFile(file, 'utf8')).trim()
  } catch {
    return '' // Missing/unreadable file → ignore.
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Truncates without splitting UTF-8 code points and keeps the entire result within the byte budget. */
function capUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(value) <= maxBytes) return value
  const suffixBytes = utf8Bytes(BYTE_TRUNCATION_SUFFIX)
  const suffix = suffixBytes <= maxBytes ? BYTE_TRUNCATION_SUFFIX : ''
  const contentBudget = maxBytes - utf8Bytes(suffix)
  const chars: string[] = []
  let used = 0
  for (const char of value) {
    const bytes = utf8Bytes(char)
    if (used + bytes > contentBudget) break
    chars.push(char)
    used += bytes
  }
  return chars.join('') + suffix
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file)
    return true
  } catch {
    return false
  }
}

async function findGitRoot(cwd: string): Promise<string | null> {
  let current = cwd
  while (true) {
    if (await pathExists(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function resolveProjectRoot(workspaceId: string, cwd: string): Promise<string> {
  const resolvedCwd = path.resolve(cwd)
  try {
    const workspacePath = getWorkspace(workspaceId)?.path
    if (workspacePath) {
      const resolvedWorkspace = path.resolve(workspacePath)
      if (isWithin(resolvedWorkspace, resolvedCwd)) return resolvedWorkspace
    }
  } catch {
    /* Store unavailable → try Git root. */
  }
  return (await findGitRoot(resolvedCwd)) ?? resolvedCwd
}

function directoriesFromRoot(root: string, cwd: string): string[] {
  if (!isWithin(root, cwd)) return [cwd]
  const relative = path.relative(root, cwd)
  if (!relative) return [root]
  const directories = [root]
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    directories.push(current)
  }
  return directories
}

function relativeSource(root: string, file: string): string {
  const relative = path.relative(root, file) || path.basename(file)
  return relative.split(path.sep).join('/')
}

interface ProjectInstructionSource {
  content: string
  source: string
}

async function discoverProjectInstructions(workspaceId: string, cwd: string): Promise<ProjectInstructionSource[]> {
  if (!cwd) return []
  const resolvedCwd = path.resolve(cwd)
  const root = await resolveProjectRoot(workspaceId, resolvedCwd)
  const discovered: ProjectInstructionSource[] = []

  for (const directory of directoriesFromRoot(root, resolvedCwd)) {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      const file = path.join(directory, name)
      const content = await readFileTrimmed(file)
      if (!content) continue

      discovered.push({ content, source: relativeSource(root, file) })
      break // Codex: at most one instruction file per directory.
    }
  }

  // Instructions closest to cwd take precedence. Reserve budget backward, then return
  // root → cwd: a huge root AGENTS.md must not silently eliminate the specific override.
  let remainingBytes = PROJECT_INSTRUCTION_BYTES
  const retained: Array<ProjectInstructionSource | null> = Array.from({ length: discovered.length }, () => null)
  for (let index = discovered.length - 1; index >= 0 && remainingBytes > 0; index -= 1) {
    const source = discovered[index]
    const content = capUtf8(source.content, remainingBytes)
    if (!content) continue
    retained[index] = { ...source, content }
    remainingBytes -= utf8Bytes(content)
  }
  return retained.filter((source): source is ProjectInstructionSource => source != null)
}

/**
 * Builds the stable block shared by all runtimes. Empty without conventions. Never throws:
 * swallow fs/store errors so chat works without project context.
 */
export async function buildProjectContext(workspaceId: string, cwd: string): Promise<string> {
  const sections: string[] = []
  try {
    const instructions = await discoverProjectInstructions(workspaceId, cwd)
    for (const instruction of instructions) {
      sections.push(`## Project instructions\nSource: ${instruction.source}\n${instruction.content}`)
    }
  } catch {
    /* fs/store unavailable → empty stable context. */
  }

  if (sections.length === 0) return ''
  const body = sections.join('\n\n')
  return `\n\n---\nProject context — sources are ordered from broad to specific; later instructions take precedence:\n\n${body}`
}

/** API compatibility: OpenAI models consume exactly the same canonical block as other runtimes. */
export async function buildOpenAIProjectContext(workspaceId: string, cwd: string): Promise<string> {
  return buildProjectContext(workspaceId, cwd)
}
