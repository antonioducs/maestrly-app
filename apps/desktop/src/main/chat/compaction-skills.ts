import type { ChatMessage, MessagePart } from '../../shared/chat'
import { normalizeSkillName, toolOutputText } from '../../shared/chat'
import { activeChatContext } from './message'

/** At most this many skill names ride along in a summary. */
export const LOADED_SKILLS_MAX = 10
const LOADED_SKILLS_BLOCK = /\n*<loaded_skills\b[^>]*>[\s\S]*?<\/loaded_skills>\n*/g
const NAMES = /\bnames="([^"]*)"/
const CARRIED = /\bcarried="([^"]*)"/

const names = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((name) => normalizeSkillName(name))
    .filter(Boolean)

/** A skill this part put into the context: a completed `use_skill` load, or a skill the user invoked. */
function loadedSkill(part: MessagePart): string | null {
  if (part.type === 'skill-invocation') return normalizeSkillName(part.name) || null
  if (part.type !== 'tool' || part.toolName.replace(/^mcp__maestrly__/, '') !== 'use_skill') return null
  if (part.state.status !== 'completed') return null
  // A load that failed answers "not found" as a completed call on some runtimes.
  if (!/^Skill "[^"]+" loaded\./.test(toolOutputText(part.state.output))) return null
  const input = part.input as { name?: unknown } | null
  return typeof input?.name === 'string' ? normalizeSkillName(input.name) || null : null
}

/**
 * The skills loaded since the previous compaction leave the context with it: their bodies are tool results the summary
 * drops. Without a reminder the agent goes on "following" a skill from memory, so the summary names them and asks to
 * load them again first. A skill named by the previous summary but not loaded again is named once more, as carried,
 * then dropped. Applied when the summary is made, like the approved plan, so the runner's window (which starts at the
 * compaction) never needs the older messages.
 */
export function summaryWithLoadedSkills(summary: string, history: readonly ChatMessage[]): string {
  const context = activeChatContext([...history])
  const loaded: string[] = []
  for (const message of context.messages)
    for (const part of message.parts) {
      const name = loadedSkill(part)
      if (name && !loaded.includes(name)) loaded.push(name)
    }
  const previous = [...context.summary.matchAll(/<loaded_skills\b([^>]*)>/g)].at(-1)?.[1] ?? ''
  const carried = names(NAMES.exec(previous)?.[1]).filter((name) => !loaded.includes(name))
  const base = summary.replace(LOADED_SKILLS_BLOCK, '\n\n').trimEnd()
  const kept = loaded.slice(0, LOADED_SKILLS_MAX)
  const keptCarried = carried.slice(0, Math.max(0, LOADED_SKILLS_MAX - kept.length))
  if (!kept.length && !keptCarried.length) return base
  const all = [...kept, ...keptCarried]
  return (
    `${base}\n\n` +
    `<loaded_skills names="${kept.join(',')}" carried="${keptCarried.join(',')}">\n` +
    `Before this compaction you had loaded these skills: ${all.join(', ')}. Their instructions are no longer in your ` +
    'context. Before relying on any of them, call use_skill again with its name and follow what it returns, not ' +
    'what you remember of it.\n</loaded_skills>'
  )
}

/** The names a summary's reminder carries, for tests and diagnostics. */
export function loadedSkillsInSummary(summary: string): { names: string[]; carried: string[] } {
  const attributes = [...summary.matchAll(/<loaded_skills\b([^>]*)>/g)].at(-1)?.[1] ?? ''
  return { names: names(NAMES.exec(attributes)?.[1]), carried: names(CARRIED.exec(attributes)?.[1]) }
}
