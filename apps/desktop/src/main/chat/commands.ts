/**
 * Chat '/' commands. Two sources (built-in actions like /clear live in the renderer):
 *  - User PROMPTS: reusable templates saved in app_settings (chat.prompts), editable
 *    in Settings. Support `$ARGUMENTS` (replaced with text after the command).
 *  - Project COMMANDS: .md files in <cwd>/.agents/commands or <cwd>/.claude/commands (shareable
 *    through git). Name = filename without .md; optional `description:` frontmatter; body = template.
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getAppSetting, setAppSetting } from '../store'
import type { ChatProjectCommand, ChatUserPrompt } from '../../shared/chat'

const PROMPTS_KEY = 'chat.prompts'
const COMMAND_DIRS = ['.agents/commands', '.claude/commands']

/** Normalizes command names: no '/', spaces→'-', lowercase, only [\w-]. */
export function normalizeCommandName(s: string): string {
  return (s ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .toLowerCase()
}

// ---------- User prompts (app_settings) ----------

export function listUserPrompts(): ChatUserPrompt[] {
  const raw = getAppSetting(PROMPTS_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.content === 'string')
      .map((p) => ({ id: p.id, name: p.name, description: typeof p.description === 'string' ? p.description : undefined, content: p.content }))
  } catch {
    return []
  }
}

function savePrompts(list: ChatUserPrompt[]): void {
  setAppSetting(PROMPTS_KEY, JSON.stringify(list))
}

export function addUserPrompt(input: { name: string; description?: string; content: string }): ChatUserPrompt {
  const name = normalizeCommandName(input?.name)
  const content = (input?.content ?? '').trim()
  if (!name) throw new Error('Enter a command name (e.g. review).')
  if (!content) throw new Error('Enter the prompt content.')
  const prompt: ChatUserPrompt = { id: 'cmd_' + randomUUID(), name, description: input?.description?.trim() || undefined, content }
  savePrompts([...listUserPrompts(), prompt])
  return prompt
}

export function updateUserPrompt(id: string, patch: { name?: string; description?: string; content?: string }): void {
  const list = listUserPrompts()
  const idx = list.findIndex((p) => p.id === id)
  if (idx < 0) return
  const next = { ...list[idx] }
  if (patch.name != null) next.name = normalizeCommandName(patch.name) || next.name
  if (patch.description != null) next.description = patch.description.trim() || undefined
  if (patch.content != null) next.content = patch.content.trim() || next.content
  list[idx] = next
  savePrompts(list)
}

export function removeUserPrompt(id: string): void {
  savePrompts(listUserPrompts().filter((p) => p.id !== id))
}

// ---------- Project commands (.md on disk) ----------

/** Extracts `description:` from simple YAML frontmatter and returns the remaining body. */
function parseFrontmatter(text: string): { description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text }
  const dm = /^description:\s*(.+)$/m.exec(m[1])
  const description = dm ? dm[1].trim().replace(/^["']|["']$/g, '') : undefined
  return { description, body: text.slice(m[0].length) }
}

export async function listProjectCommands(cwd: string): Promise<ChatProjectCommand[]> {
  if (!cwd) return []
  const out: ChatProjectCommand[] = []
  const seen = new Set<string>()
  for (const rel of COMMAND_DIRS) {
    const dir = path.join(cwd, rel)
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue // Directory does not exist → ignore.
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue
      const name = normalizeCommandName(e.name.replace(/\.md$/i, ''))
      if (!name || seen.has(name)) continue
      try {
        const raw = await fsp.readFile(path.join(dir, e.name), 'utf8')
        const { description, body } = parseFrontmatter(raw)
        const content = body.trim()
        if (!content) continue
        out.push({ name, description, content, source: `${rel}/${e.name}` })
        seen.add(name)
      } catch {
        /* Unreadable file → skip. */
      }
    }
  }
  return out
}
