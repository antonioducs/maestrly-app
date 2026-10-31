import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { botRuntimeForConversation } from '../../fleet/instance'
import type { BotSkillStore, BotSkillSummary } from '../../fleet/instance/bot-skills/store'
import { BOT_SKILL_LIMITS, BotSkillError, SKILL_MD } from '../../fleet/instance/bot-skills/validation'
import { listConversationSkills } from '../../chat/skill-state'
import { normalizedSkillName, type ChatSkill } from '../../chat/skills'
import { err, ok, type McpToolContext } from './context'

/** What the skill tools of one conversation reach: its bot's own skills, and the other skills it can see. */
export interface BotSkillToolsHost {
  store(): BotSkillStore | null
  /** Skills the conversation sees from other sources (environment, plugins): readable, never editable. */
  otherSkills(): Promise<ChatSkill[]>
}

export function botSkillToolsHost(conversationId: string): BotSkillToolsHost {
  return {
    store: () => botRuntimeForConversation(conversationId)?.skills ?? null,
    otherSkills: async () =>
      (await listConversationSkills('', conversationId)).filter((skill) => skill.scope !== 'bot'),
  }
}

const VIEW_MAX_CHARS = 64_000
const nameSchema = z.string().trim().min(1).max(BOT_SKILL_LIMITS.nameMax)
const reasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(BOT_SKILL_LIMITS.reasonMax)
  .describe('One line saying why: what you learned or what was wrong. Your owner sees it in the skill history.')
const filePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(BOT_SKILL_LIMITS.pathMax)
  .describe('SKILL.md, or a file under scripts/, templates/, references/ or assets/, such as "scripts/render.sh".')

const day = (time: number) => new Date(time).toISOString().slice(0, 10)
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

function ownLine(skill: BotSkillSummary, shadowed: ReadonlySet<string>): string {
  const notes = [
    skill.status,
    skill.uses ? `used ${skill.uses}×, last ${day(skill.lastUsedAt ?? 0)}` : 'not used yet',
    skill.createdBy === 'bot'
      ? 'created by you'
      : skill.createdBy === 'owner'
        ? 'created by your owner'
        : 'suggested by memory review',
    skill.lastEditedBy === 'owner' && skill.createdBy !== 'owner' ? 'edited by your owner' : '',
    skill.hasScripts ? 'has scripts' : '',
    skill.locked ? 'locked by your owner' : '',
    skill.proposal
      ? `pending proposal (${skill.proposal.actor === 'memory-review' ? 'from memory review' : 'yours'})`
      : '',
    shadowed.has(skill.name) ? 'hidden: an installed skill has the same name' : '',
    skill.absorbedInto ? `absorbed into ${skill.absorbedInto}` : '',
  ].filter(Boolean)
  return `- ${skill.name} [${notes.join(' · ')}] — ${cut(skill.description || '(no description)', 200)}`
}

function failure(error: unknown, fallback: string) {
  if (error instanceof BotSkillError) return err(error.message)
  console.warn('[bot-skills] Tool failed', error instanceof Error ? error.message : String(error))
  return err(fallback)
}

function writeResult(
  result: { name: string; applied: 'library' | 'proposal'; path?: string; revision: number; advice: string[] },
  verb: string
) {
  return ok(
    [
      result.applied === 'library'
        ? `${verb} ${result.path ? `${result.path} of ` : ''}your skill "${result.name}". It is in effect now (revision ${result.revision}); load it with use_skill.`
        : `${verb} ${result.path ? `${result.path} of ` : ''}"${result.name}" as a proposal: your owner reviews it before it takes effect. Further changes to this skill add to the same proposal.`,
      ...result.advice.map((line) => `Note: ${line}`),
    ].join('\n')
  )
}

/** Reads a file of a skill from another source, inside its folder only. */
async function readOtherSkillFile(skill: ChatSkill, filePath: string | undefined): Promise<string> {
  const relative = (filePath ?? SKILL_MD).trim() || SKILL_MD
  if (
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    relative.split('/').some((segment) => segment === '..' || segment === '')
  )
    throw new BotSkillError('Give a path relative to the skill folder, such as "SKILL.md" or "references/api.md".')
  const root = await fsp.realpath(skill.dir)
  const target = await fsp.realpath(path.join(root, relative)).catch(() => null)
  if (!target || (target !== root && !target.startsWith(root + path.sep)))
    throw new BotSkillError(`Skill "${skill.name}" has no file ${relative}.`, 'not-found')
  const stat = await fsp.stat(target)
  if (!stat.isFile()) throw new BotSkillError(`${relative} is not a file of skill "${skill.name}".`, 'not-found')
  if (stat.size > BOT_SKILL_LIMITS.fileBytes)
    throw new BotSkillError(`${relative} is larger than ${BOT_SKILL_LIMITS.fileBytes / 1024} KiB.`, 'limit')
  return fsp.readFile(target, 'utf8')
}

/**
 * The tools a fleet bot uses to keep its own skills: procedures it learned, with their scripts and templates, that its
 * later conversations and routine runs find in the skill catalog. It changes only its own skills; the skills of its
 * environment and plugins are readable here and loaded with `use_skill`.
 */
export function registerBotSkillTools(
  ctx: McpToolContext,
  host: BotSkillToolsHost = botSkillToolsHost(ctx.convId)
): void {
  const store = () => {
    const found = host.store()
    if (!found) throw new BotSkillError('Your own skills are available only in your bot conversations.')
    return found
  }
  const taken = async () => new Set((await host.otherSkills()).map((skill) => skill.name))
  const writer = (reason: string) => ({ actor: 'bot' as const, conversationId: ctx.convId, reason })

  ctx.server.registerTool(
    'skill_list',
    {
      description:
        'List your own skills (status, use, pending proposals) and the other skills you can load with use_skill. Check here before creating a skill: extend an existing one when it covers the same kind of task.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Also list your archived skills.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ include_archived }) => {
      try {
        const own = await store().list()
        const others = await host.otherSkills()
        const otherNames = new Set(others.map((skill) => skill.name))
        const shadowed = new Set(own.filter((skill) => otherNames.has(skill.name)).map((skill) => skill.name))
        const shown = own.filter((skill) => include_archived || skill.status !== 'archived')
        const archived = own.length - own.filter((skill) => skill.status !== 'archived').length
        const review = await store().review()
        const lines = [
          `Your skills (${own.filter((skill) => skill.status === 'active').length} active of at most ${BOT_SKILL_LIMITS.activeSkills}${archived && !include_archived ? `, ${archived} archived not shown` : ''}):`,
          ...(shown.length ? shown.map((skill) => ownLine(skill, shadowed)) : ['(none yet)']),
          review === 'approve'
            ? 'Your owner reviews your skill changes: new skills and edits wait as proposals until they approve them.'
            : 'Your skill changes take effect at once; your owner can see, edit and revert them.',
          '',
          'Other skills you can load with use_skill (read them with skill_view; you cannot change them):',
          ...(others.length
            ? others.map(
                (skill) => `- ${skill.name} (${skill.scope}) — ${cut(skill.description || '(no description)', 160)}`
              )
            : ['(none)']),
        ]
        return ok(cut(lines.join('\n'), 24_000))
      } catch (error) {
        return failure(error, 'Could not list the skills.')
      }
    }
  )

  ctx.server.registerTool(
    'skill_view',
    {
      description:
        'Read a file of a skill: SKILL.md by default, or one of its scripts, templates or references. For your own skills this shows your pending proposal when there is one, and is required before you change a file.',
      inputSchema: { name: nameSchema, file_path: filePathSchema.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ name, file_path }) => {
      try {
        const key = normalizedSkillName(name)
        const own = host.store()
        if (own && (await own.has(key))) {
          const view = await own.view(key, file_path, ctx.convId)
          const label =
            view.status === 'archived'
              ? 'your archived skill'
              : view.proposal
                ? 'your pending proposal'
                : view.status === 'proposed'
                  ? 'your proposed skill'
                  : 'your skill'
          return ok(
            `${view.path} of ${label} "${key}". Files: ${view.files.join(', ')}.\n--- ${view.path} ---\n${cut(view.content, VIEW_MAX_CHARS)}`
          )
        }
        const other = (await host.otherSkills()).find((skill) => skill.name === key)
        if (!other) return err(`No skill named "${name}". List the skills with skill_list.`)
        const content = await readOtherSkillFile(other, file_path)
        return ok(
          `${file_path ?? SKILL_MD} of the ${other.scope} skill "${other.name}" (read-only: you cannot change it; create a skill of your own instead). Files: ${[SKILL_MD, ...other.resources].join(', ')}.\n--- ${file_path ?? SKILL_MD} ---\n${cut(content, VIEW_MAX_CHARS)}`
        )
      } catch (error) {
        return failure(error, 'Could not read the skill.')
      }
    }
  )

  ctx.server.registerTool(
    'skill_create',
    {
      description:
        'Save a procedure you worked out as a skill of your own, for a kind of task you will do again: ordered steps with the exact commands, tools, parameters and checks that worked, and the pitfalls next to the step they affect. Write a one-line description that starts with when to use it ("Use when …"). Prefer extending an existing skill (skill_patch) over creating one per incident.',
      inputSchema: {
        name: nameSchema.describe('Lowercase words joined by hyphens, naming the kind of task, e.g. "make-animation".'),
        description: z
          .string()
          .trim()
          .min(1)
          .max(BOT_SKILL_LIMITS.descriptionMax)
          .describe('One line: when to use the skill, then what it produces.'),
        body: z
          .string()
          .min(1)
          .max(BOT_SKILL_LIMITS.skillMdBytes)
          .describe('The instructions (Markdown) after the frontmatter, which the host writes.'),
        reason: reasonSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, description, body, reason }) => {
      try {
        return writeResult(
          await store().create({ name, description, body, taken: await taken() }, writer(reason)),
          'Created'
        )
      } catch (error) {
        return failure(error, 'Could not create the skill.')
      }
    }
  )

  ctx.server.registerTool(
    'skill_patch',
    {
      description:
        'Change one of your skills by replacing an exact span of one file (read it with skill_view first). The span must appear once, unless replace_all is set. Fix a step that was wrong in place instead of appending an update.',
      inputSchema: {
        name: nameSchema,
        old_text: z.string().min(1).max(BOT_SKILL_LIMITS.skillMdBytes).describe('The exact text to replace.'),
        new_text: z.string().max(BOT_SKILL_LIMITS.fileBytes).describe('The text that replaces it; empty removes it.'),
        replace_all: z.boolean().optional(),
        file_path: filePathSchema.optional(),
        reason: reasonSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, old_text, new_text, replace_all, file_path, reason }) => {
      try {
        return writeResult(
          await store().patch(
            {
              name: normalizedSkillName(name),
              filePath: file_path,
              oldText: old_text,
              newText: new_text,
              replaceAll: replace_all,
            },
            writer(reason)
          ),
          'Changed'
        )
      } catch (error) {
        return failure(error, 'Could not change the skill.')
      }
    }
  )

  ctx.server.registerTool(
    'skill_write_file',
    {
      description:
        'Create or replace a whole file of one of your skills: a script, template or reference, or SKILL.md itself (keeping its frontmatter name). Set delete to remove a file. Replacing or removing an existing file needs a skill_view of it first. Scripts run only through your terminal, under your usual command permissions.',
      inputSchema: {
        name: nameSchema,
        file_path: filePathSchema,
        content: z.string().max(BOT_SKILL_LIMITS.fileBytes).optional().describe('The whole file (UTF-8 text).'),
        delete: z.boolean().optional().describe('Remove the file instead of writing it.'),
        reason: reasonSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, file_path, content, delete: remove, reason }) => {
      try {
        return writeResult(
          await store().writeFile(
            { name: normalizedSkillName(name), filePath: file_path, content, delete: remove === true },
            writer(reason)
          ),
          remove ? 'Removed' : 'Saved'
        )
      } catch (error) {
        return failure(error, 'Could not save the file.')
      }
    }
  )

  ctx.server.registerTool(
    'skill_archive',
    {
      description:
        'Archive one of your skills that no longer applies, or restore an archived one (restore: true). When you merged it into another skill, name that skill in absorbed_into. Archived skills leave the catalog but are kept; nothing is deleted.',
      inputSchema: {
        name: nameSchema,
        restore: z.boolean().optional(),
        absorbed_into: nameSchema.optional().describe('Your skill that now covers this one.'),
        reason: reasonSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, restore, absorbed_into, reason }) => {
      try {
        const result = await store().archive(
          { name: normalizedSkillName(name), restore: restore === true, absorbedInto: absorbed_into },
          writer(reason)
        )
        return ok(
          result.status === 'active'
            ? `Restored your skill "${result.name}"; it is back in the catalog.`
            : `Archived your skill "${result.name}". Restore it with skill_archive (restore: true) if you need it again.`
        )
      } catch (error) {
        return failure(error, 'Could not archive the skill.')
      }
    }
  )

  ctx.server.registerTool(
    'skill_proposal',
    {
      description:
        'Apply or discard a pending proposal of one of your skills, such as a procedure memory review suggested. Applying works only while your changes take effect without your owner’s review; otherwise the proposal waits for them.',
      inputSchema: {
        name: nameSchema,
        action: z.enum(['apply', 'discard']),
        reason: reasonSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, action, reason }) => {
      try {
        const result = await store().resolveProposal({ name: normalizedSkillName(name), action }, writer(reason ?? ''))
        return ok(
          result.status === 'discarded' || action === 'discard'
            ? `Discarded the proposal for "${result.name}".`
            : `Applied the proposal: your skill "${result.name}" is in effect now.`
        )
      } catch (error) {
        return failure(error, 'Could not resolve the proposal.')
      }
    }
  )
}
