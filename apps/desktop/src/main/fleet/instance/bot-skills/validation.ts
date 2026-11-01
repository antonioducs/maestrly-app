import { memoryContentProblem } from '../../../memory/content-safety'
import { parseSkillFrontmatter } from '../../../chat/skills'
import { normalizeCommandName } from '../../../chat/commands'

/** Limits of the skills a bot keeps for itself. */
export const BOT_SKILL_LIMITS = {
  /** Same as a strict Agent Skills name, and as the fleet's skill names. */
  nameMax: 64,
  descriptionMax: 1_024,
  /** Above this, the description still saves but the bot is told to shorten it: it is what the catalog shows. */
  descriptionAdvice: 200,
  skillMdBytes: 64 * 1024,
  fileBytes: 256 * 1024,
  filesPerSkill: 40,
  bytesPerSkill: 1024 * 1024,
  pathMax: 240,
  pathDepth: 5,
  activeSkills: 100,
  /** Every skill the bot keeps, archived ones included, so its state stays small. */
  totalSkills: 300,
  proposals: 20,
  versionsPerSkill: 20,
  reasonMax: 300,
} as const

export const BOT_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const BOT_SKILL_FILE_DIRS = ['scripts', 'templates', 'references', 'assets'] as const
export const SKILL_MD = 'SKILL.md'

export class BotSkillError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid'
      | 'not-found'
      | 'exists'
      | 'not-own'
      | 'read-first'
      | 'stale-read'
      | 'locked'
      | 'limit'
      | 'conflict'
      | 'unsafe'
      | 'damaged' = 'invalid'
  ) {
    super(message)
    this.name = 'BotSkillError'
  }
}

export function botSkillNameProblem(name: string): string | null {
  if (!name) return 'Give the skill a name.'
  if (name.length > BOT_SKILL_LIMITS.nameMax) return `A skill name has at most ${BOT_SKILL_LIMITS.nameMax} characters.`
  if (!BOT_SKILL_NAME.test(name))
    return 'A skill name uses lowercase letters and digits in words joined by single hyphens, for example "make-animation".'
  return null
}
export function assertBotSkillName(name: string): void {
  const problem = botSkillNameProblem(name)
  if (problem) throw new BotSkillError(problem)
}

/** A description is one line, since the catalog shows it on the skill's line and the frontmatter keeps it unquoted. */
export function descriptionProblem(description: string): string | null {
  const text = description.trim()
  if (!text) return 'Give the skill a description that says when to use it.'
  if (/[\r\n]/.test(text)) return 'Write the description on one line.'
  if (text.length > BOT_SKILL_LIMITS.descriptionMax)
    return `A description has at most ${BOT_SKILL_LIMITS.descriptionMax} characters.`
  if (/^[|>&*!%@`'"[{#-]/.test(text))
    return 'Start the description with a word (it is written to the skill frontmatter as is).'
  return null
}
export function descriptionAdvice(description: string): string[] {
  const advice: string[] = []
  if (description.trim().length > BOT_SKILL_LIMITS.descriptionAdvice)
    advice.push(
      `The description has more than ${BOT_SKILL_LIMITS.descriptionAdvice} characters; the catalog may shorten it, so put when to use the skill first.`
    )
  if (!/\b(use|when|whenever|for)\b/i.test(description))
    advice.push('Say in the description when to use the skill, for example "Use when …".')
  return advice
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Text a skill keeps is replayed into the bot's context later, so it passes the same checks as memory. */
export function assertSkillText(path: string, text: string, maxBytes: number): void {
  if (text.includes('\0') || LONE_SURROGATE.test(text))
    throw new BotSkillError(`${path} must be UTF-8 text; skills keep no binary files.`)
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    throw new BotSkillError(`${path} would have more than ${Math.floor(maxBytes / 1024)} KiB.`)
  const problem = memoryContentProblem(text)
  if (problem === 'invisible-characters')
    throw new BotSkillError(`${path} contains invisible or direction-changing characters; remove them.`, 'unsafe')
  if (problem === 'instruction-injection')
    throw new BotSkillError(
      `${path} contains text that reads as an instruction to ignore earlier instructions, or a command that pipes a download into a shell. Rewrite it without that.`,
      'unsafe'
    )
}

/**
 * A relative path inside a skill: `SKILL.md`, or a file under one of its resource folders. Plain segments only: no
 * hidden names, no `..`, no backslash, no absolute paths.
 */
export function normalizeSkillFilePath(input: string | undefined): string {
  const value = (input ?? SKILL_MD).trim()
  if (value === SKILL_MD) return SKILL_MD
  if (!value || value.length > BOT_SKILL_LIMITS.pathMax || value.includes('\\') || value.includes('\0'))
    throw new BotSkillError(
      `Give a file path such as "scripts/render.sh"; at most ${BOT_SKILL_LIMITS.pathMax} characters.`
    )
  const segments = value.split('/')
  if (
    segments.length < 2 ||
    segments.length > BOT_SKILL_LIMITS.pathDepth ||
    segments.some((segment) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.endsWith('.tmp'))
  )
    throw new BotSkillError(
      `A skill file lives in ${BOT_SKILL_FILE_DIRS.map((dir) => `${dir}/`).join(', ')} with plain names (letters, digits, ".", "_", "-"; no hidden names or "..").`
    )
  if (!(BOT_SKILL_FILE_DIRS as readonly string[]).includes(segments[0]))
    throw new BotSkillError(
      `Put the file in one of ${BOT_SKILL_FILE_DIRS.map((dir) => `${dir}/`).join(', ')}, or edit ${SKILL_MD}.`
    )
  return segments.join('/')
}

/** The frontmatter the host writes: only the name and the one-line description. */
export function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description.trim()}\n---\n\n${body.trim()}\n`
}

/** A whole `SKILL.md` the bot wrote or patched: same name, a description, instructions, and the same checks. */
export function assertSkillMarkdown(name: string, markdown: string): { description: string } {
  assertSkillText(SKILL_MD, markdown, BOT_SKILL_LIMITS.skillMdBytes)
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(markdown))
    throw new BotSkillError(`${SKILL_MD} must start with a frontmatter block: ---, name, description, ---.`)
  const { fields, body } = parseSkillFrontmatter(markdown)
  if (normalizeCommandName(fields.name ?? '') !== name || (fields.name ?? '').trim() !== name)
    throw new BotSkillError(`The frontmatter of ${SKILL_MD} must keep "name: ${name}".`)
  const problem = descriptionProblem(fields.description ?? '')
  if (problem) throw new BotSkillError(problem)
  if (!body.trim()) throw new BotSkillError(`${SKILL_MD} needs instructions after its frontmatter.`)
  return { description: (fields.description ?? '').trim() }
}

export function reasonText(reason: string | undefined): string {
  return (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, BOT_SKILL_LIMITS.reasonMax)
}
