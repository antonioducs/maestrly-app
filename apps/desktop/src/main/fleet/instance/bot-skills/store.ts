import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { parseSkillFrontmatter, readSkillDirectory, type ChatSkill } from '../../../chat/skills'
import type { ConversationSkillProvider } from '../../../chat/conversation-skill-provider'
import {
  BOT_SKILL_LIMITS,
  BOT_SKILL_NAME,
  BotSkillError,
  SKILL_MD,
  assertBotSkillName,
  assertSkillMarkdown,
  assertSkillText,
  descriptionAdvice,
  descriptionProblem,
  normalizeSkillFilePath,
  reasonText,
  skillMarkdown,
} from './validation'

/**
 * The skills a fleet bot keeps for itself, in its own folder (`fleet-instance/bots/<botId>/skills`), which moves,
 * backs up and is deleted with the bot:
 *
 *   library/<name>/    the skills its conversations discover (SKILL.md plus scripts/, templates/, references/, assets/)
 *   archive/<name>/    archived skills, restorable
 *   proposals/<name>/  changes waiting for the owner (or for the bot to adopt a memory-review suggestion)
 *   blobs/<sha256>     the content of every version, stored once
 *   state.json         provenance, versions, review mode and usage
 *
 * Every change runs alone (one queue per bot), writes files through a temporary file and a rename, and records a
 * version the owner can go back to. A damaged state file is set aside and rebuilt from the folders, never deleted.
 */

export const BOT_SKILL_ACTORS = ['bot', 'owner', 'memory-review'] as const
export type BotSkillActor = (typeof BOT_SKILL_ACTORS)[number]
export const BOT_SKILL_ACTIONS = [
  'create',
  'patch',
  'write-file',
  'remove-file',
  'revert',
  'archive',
  'restore',
  'approve',
] as const
export type BotSkillAction = (typeof BOT_SKILL_ACTIONS)[number]
export type BotSkillStatus = 'active' | 'archived' | 'proposed'
export type BotSkillReview = 'auto' | 'approve'

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/)
const timeSchema = z.number().int().nonnegative()
const versionSchema = z
  .object({
    id: z.string().min(1).max(64),
    at: timeSchema,
    actor: z.enum(BOT_SKILL_ACTORS),
    action: z.enum(BOT_SKILL_ACTIONS),
    reason: z.string().max(BOT_SKILL_LIMITS.reasonMax),
    conversationId: z.string().min(1).max(200).optional(),
    files: z.record(z.string().min(1).max(BOT_SKILL_LIMITS.pathMax), shaSchema),
  })
  .strict()
const proposalSchema = z
  .object({
    actor: z.enum(BOT_SKILL_ACTORS),
    reason: z.string().max(BOT_SKILL_LIMITS.reasonMax),
    createdAt: timeSchema,
    updatedAt: timeSchema,
    conversationId: z.string().min(1).max(200).optional(),
    /** The skill's revision when the proposal started: the owner sees whether it changed since. */
    baseRevision: z.number().int().nonnegative(),
  })
  .strict()
const skillSchema = z
  .object({
    status: z.enum(['active', 'archived', 'proposed']),
    createdBy: z.enum(BOT_SKILL_ACTORS),
    lastEditedBy: z.enum(BOT_SKILL_ACTORS),
    createdAt: timeSchema,
    updatedAt: timeSchema,
    revision: z.number().int().nonnegative(),
    locked: z.boolean(),
    absorbedInto: z.string().max(200).optional(),
    proposal: proposalSchema.optional(),
    versions: z.array(versionSchema).max(BOT_SKILL_LIMITS.versionsPerSkill),
  })
  .strict()
const usageSchema = z.object({ count: z.number().int().nonnegative(), lastUsedAt: timeSchema }).strict()
const stateSchema = z
  .object({
    version: z.literal(1),
    review: z.enum(['auto', 'approve']),
    skills: z.record(z.string().regex(BOT_SKILL_NAME).max(BOT_SKILL_LIMITS.nameMax), skillSchema),
    usage: z.record(z.string().min(1).max(200), usageSchema),
  })
  .strict()
type State = z.infer<typeof stateSchema>
type SkillRecord = z.infer<typeof skillSchema>
export type BotSkillVersion = z.infer<typeof versionSchema>
export type BotSkillProposal = z.infer<typeof proposalSchema>
const USAGE_MAX = 500

export interface BotSkillSummary {
  name: string
  description: string
  status: BotSkillStatus
  createdBy: BotSkillActor
  lastEditedBy: BotSkillActor
  createdAt: number
  updatedAt: number
  revision: number
  locked: boolean
  files: number
  hasScripts: boolean
  uses: number
  lastUsedAt: number | null
  absorbedInto?: string
  proposal: BotSkillProposal | null
}
export interface BotSkillFile {
  path: string
  content: string
}
export interface BotSkillDetail extends BotSkillSummary {
  currentFiles: BotSkillFile[]
  proposalFiles: BotSkillFile[] | null
  versions: BotSkillVersion[]
}

/** Who asks for a change, and from which conversation. */
export interface BotSkillWriter {
  actor: BotSkillActor
  conversationId?: string
  reason?: string
}
export interface BotSkillWriteResult {
  name: string
  /** `library` when the change is in effect, `proposal` when it waits for approval. */
  applied: 'library' | 'proposal'
  path?: string
  revision: number
  advice: string[]
}

type Area = 'library' | 'archive' | 'proposals'
type Files = Map<string, string>

export class BotSkillStore {
  private chain: Promise<unknown> = Promise.resolve()
  private state: State | null = null
  /** What each conversation last read of a skill file (sha), so an edit always starts from what it saw. */
  private readonly reads = new Map<string, Map<string, string>>()

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now
  ) {}

  // ---- discovery ----

  /** The bot's active skills, as its conversations discover them. */
  async librarySkills(): Promise<ChatSkill[]> {
    const state = await this.read()
    const skills: ChatSkill[] = []
    for (const [name, record] of Object.entries(state.skills).sort(([a], [b]) => a.localeCompare(b))) {
      if (record.status !== 'active') continue
      if (!(await this.isRealDir(this.dir('library', name)))) continue
      const skill = await readSkillDirectory(this.areaDir('library'), name, "This bot's skills", 'bot')
      if (skill?.name === name) skills.push(skill)
    }
    return skills
  }

  /** What `setConversationSkillProvider` gets for one of the bot's conversations. */
  provider(conversationId: string): ConversationSkillProvider {
    return {
      list: () => this.librarySkills(),
      usage: () => this.state?.usage ?? {},
      recordUse: (skill) => this.recordUse(conversationId, skill),
    }
  }

  forgetConversation(conversationId: string): void {
    this.reads.delete(conversationId)
  }

  async recordUse(conversationId: string, skill: Pick<ChatSkill, 'name' | 'scope'>): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load()
      const usage = state.usage[skill.name] ?? { count: 0, lastUsedAt: 0 }
      state.usage[skill.name] = { count: usage.count + 1, lastUsedAt: this.now() }
      const names = Object.keys(state.usage)
      if (names.length > USAGE_MAX)
        for (const name of names
          .sort((a, b) => state.usage[a].lastUsedAt - state.usage[b].lastUsedAt)
          .slice(0, names.length - USAGE_MAX))
          delete state.usage[name]
      await this.save(state)
      // Loading a skill shows its SKILL.md: that counts as reading it before an edit.
      if (
        skill.scope === 'bot' &&
        state.skills[skill.name]?.status === 'active' &&
        !state.skills[skill.name].proposal
      ) {
        const files = await this.readFiles('library', skill.name)
        const text = files.get(SKILL_MD)
        if (text !== undefined) this.noteRead(conversationId, skill.name, SKILL_MD, text)
      }
    })
  }

  // ---- reads ----

  async review(): Promise<BotSkillReview> {
    return (await this.read()).review
  }

  async has(name: string): Promise<boolean> {
    return Boolean((await this.read()).skills[name])
  }

  async list(): Promise<BotSkillSummary[]> {
    const state = await this.read()
    const out: BotSkillSummary[] = []
    for (const [name, record] of Object.entries(state.skills).sort(([a], [b]) => a.localeCompare(b)))
      out.push(this.summary(name, record, state, await this.readFiles(this.viewArea(record), name)))
    return out
  }

  async detail(name: string): Promise<BotSkillDetail> {
    const state = await this.read()
    const record = this.own(state, name)
    const area = record.status === 'archived' ? 'archive' : 'library'
    const files = record.status === 'proposed' ? new Map<string, string>() : await this.readFiles(area, name)
    const proposalFiles = record.proposal ? await this.readFiles('proposals', name) : null
    return {
      ...this.summary(name, record, state, proposalFiles && record.status === 'proposed' ? proposalFiles : files),
      currentFiles: sortedFiles(files),
      proposalFiles: proposalFiles ? sortedFiles(proposalFiles) : null,
      versions: [...record.versions].reverse(),
    }
  }

  /** The files of one version, for a diff with the current ones. */
  async versionFiles(name: string, versionId: string): Promise<BotSkillFile[]> {
    const record = this.own(await this.read(), name)
    const version = record.versions.find((item) => item.id === versionId)
    if (!version) throw new BotSkillError(`Skill "${name}" has no version ${versionId}.`, 'not-found')
    return sortedFiles(await this.blobFiles(version.files))
  }

  /**
   * One file of a skill as the bot sees it: its pending proposal when it has one, else what is in effect. Recorded as
   * read by `conversationId`, so that conversation may edit it next.
   */
  async view(
    name: string,
    filePath: string | undefined,
    conversationId: string
  ): Promise<{ path: string; content: string; files: string[]; proposal: boolean; status: BotSkillStatus }> {
    const file = normalizeSkillFilePath(filePath)
    const state = await this.read()
    const record = this.own(state, name)
    const area = this.viewArea(record)
    const files = await this.readFiles(area, name)
    const content = files.get(file)
    if (content === undefined)
      throw new BotSkillError(
        `Skill "${name}" has no file ${file}. Its files: ${[...files.keys()].sort().join(', ') || '(none)'}.`,
        'not-found'
      )
    this.noteRead(conversationId, name, file, content)
    return {
      path: file,
      content,
      files: [...files.keys()].sort(),
      proposal: area === 'proposals',
      status: record.status,
    }
  }

  // ---- changes the bot (or memory review) asks for ----

  async create(
    input: { name: string; description: string; body: string; taken: ReadonlySet<string> },
    writer: BotSkillWriter
  ): Promise<BotSkillWriteResult> {
    assertBotSkillName(input.name)
    const problem = descriptionProblem(input.description)
    if (problem) throw new BotSkillError(problem)
    if (input.taken.has(input.name))
      throw new BotSkillError(
        `A skill named "${input.name}" is already available to you (installed by your owner, the environment or a plugin). Choose another name, or extend one of your own skills.`,
        'exists'
      )
    const markdown = skillMarkdown(input.name, input.description, input.body)
    assertSkillMarkdown(input.name, markdown)
    return this.exclusive(async () => {
      const state = await this.load()
      const existing = state.skills[input.name]
      if (existing)
        throw new BotSkillError(
          existing.status === 'archived'
            ? `You already have an archived skill "${input.name}": restore it with skill_archive (restore: true), then edit it.`
            : `You already have a skill "${input.name}": read it with skill_view and change it with skill_patch.`,
          'exists'
        )
      const records = Object.values(state.skills)
      if (records.length >= BOT_SKILL_LIMITS.totalSkills)
        throw new BotSkillError(
          `You keep ${BOT_SKILL_LIMITS.totalSkills} skills already. Extend an existing one instead.`,
          'limit'
        )
      const proposal = writer.actor !== 'owner' && (writer.actor === 'memory-review' || state.review === 'approve')
      if (!proposal && records.filter((record) => record.status === 'active').length >= BOT_SKILL_LIMITS.activeSkills)
        throw new BotSkillError(
          `You have ${BOT_SKILL_LIMITS.activeSkills} active skills, the most you can. Extend an existing one, or archive one you no longer use.`,
          'limit'
        )
      if (proposal) this.assertProposalRoom(state, input.name)
      const at = this.now()
      const files: Files = new Map([[SKILL_MD, markdown]])
      const record: SkillRecord = {
        status: proposal ? 'proposed' : 'active',
        createdBy: writer.actor,
        lastEditedBy: writer.actor,
        createdAt: at,
        updatedAt: at,
        revision: 1,
        locked: false,
        versions: [],
      }
      if (proposal) {
        await this.replaceArea('proposals', input.name, files)
        record.proposal = this.newProposal(writer, at, 0)
      } else {
        await this.replaceArea('library', input.name, files)
        await this.addVersion(record, files, 'create', writer, at)
      }
      state.skills[input.name] = record
      await this.save(state)
      if (writer.conversationId) this.noteRead(writer.conversationId, input.name, SKILL_MD, markdown)
      if (!proposal) await this.collectBlobs(state)
      return {
        name: input.name,
        applied: proposal ? 'proposal' : 'library',
        path: SKILL_MD,
        revision: record.revision,
        advice: descriptionAdvice(input.description),
      }
    })
  }

  /** Replaces an exact, unique span of one file (every occurrence with `replaceAll`). */
  async patch(
    input: { name: string; filePath?: string; oldText: string; newText: string; replaceAll?: boolean },
    writer: BotSkillWriter
  ): Promise<BotSkillWriteResult> {
    const file = normalizeSkillFilePath(input.filePath)
    if (!input.oldText) throw new BotSkillError('Give the exact text to replace in old_text.')
    return this.change(input.name, writer, file, (files) => {
      const current = files.get(file)
      if (current === undefined)
        throw new BotSkillError(
          `Skill "${input.name}" has no file ${file}; create it with skill_write_file.`,
          'not-found'
        )
      const count = current.split(input.oldText).length - 1
      if (count === 0)
        throw new BotSkillError(
          `old_text was not found in ${file}. Read the file again with skill_view and copy the exact text, whitespace included.`
        )
      if (count > 1 && !input.replaceAll)
        throw new BotSkillError(
          `old_text appears ${count} times in ${file}. Include more surrounding text so it is unique, or set replace_all.`
        )
      files.set(file, current.split(input.oldText).join(input.newText))
      return 'patch'
    })
  }

  /** Creates or replaces one file (SKILL.md included), or removes a resource file. */
  async writeFile(
    input: { name: string; filePath: string; content?: string; delete?: boolean },
    writer: BotSkillWriter,
    expectRevision?: number
  ): Promise<BotSkillWriteResult> {
    const file = normalizeSkillFilePath(input.filePath)
    if (input.delete && file === SKILL_MD)
      throw new BotSkillError(`${SKILL_MD} cannot be removed; archive the skill with skill_archive instead.`)
    if (!input.delete && input.content === undefined) throw new BotSkillError('Give the file content.')
    return this.change(
      input.name,
      writer,
      file,
      (files) => {
        if (input.delete) {
          if (!files.has(file)) throw new BotSkillError(`Skill "${input.name}" has no file ${file}.`, 'not-found')
          files.delete(file)
          return 'remove-file'
        }
        files.set(file, input.content!)
        return 'write-file'
      },
      { newFileNeedsNoRead: !input.delete, expectRevision }
    )
  }

  /** Archives an active skill or restores an archived one. Nothing is ever deleted by the bot. */
  async archive(
    input: { name: string; restore?: boolean; absorbedInto?: string },
    writer: BotSkillWriter,
    expectRevision?: number
  ): Promise<{ name: string; status: BotSkillStatus; revision: number }> {
    return this.exclusive(async () => {
      const state = await this.load()
      const record = this.own(state, input.name)
      if (expectRevision !== undefined) this.expect(record, expectRevision)
      if (writer.actor !== 'owner' && record.locked)
        throw new BotSkillError(
          `Your owner locked the skill "${input.name}"; ask them to archive or restore it.`,
          'locked'
        )
      if (record.proposal)
        throw new BotSkillError(
          `Skill "${input.name}" has a pending proposal; apply or discard it with skill_proposal first.`,
          'conflict'
        )
      const at = this.now()
      if (input.restore) {
        if (record.status !== 'archived') throw new BotSkillError(`Skill "${input.name}" is not archived.`)
        const active = Object.values(state.skills).filter((item) => item.status === 'active').length
        if (active >= BOT_SKILL_LIMITS.activeSkills)
          throw new BotSkillError(
            `You have ${BOT_SKILL_LIMITS.activeSkills} active skills, the most you can; archive one first.`,
            'limit'
          )
        let files = await this.readFiles('archive', input.name)
        if (!files.size && record.versions.length)
          files = await this.blobFiles(record.versions[record.versions.length - 1].files)
        if (!files.has(SKILL_MD))
          throw new BotSkillError(`The archived copy of "${input.name}" is missing; nothing to restore.`, 'not-found')
        await this.replaceArea('library', input.name, files)
        await this.removeArea('archive', input.name)
        record.status = 'active'
        delete record.absorbedInto
        await this.addVersion(record, files, 'restore', writer, at)
      } else {
        if (record.status !== 'active') throw new BotSkillError(`Skill "${input.name}" is not active.`)
        if (input.absorbedInto !== undefined && !state.skills[input.absorbedInto] && input.absorbedInto !== '')
          throw new BotSkillError(`absorbed_into must name one of your skills; "${input.absorbedInto}" is not one.`)
        if (input.absorbedInto === input.name) throw new BotSkillError('A skill cannot be absorbed into itself.')
        const files = await this.readFiles('library', input.name)
        await this.replaceArea('archive', input.name, files)
        await this.removeArea('library', input.name)
        record.status = 'archived'
        if (input.absorbedInto) record.absorbedInto = input.absorbedInto
        await this.addVersion(record, files, 'archive', writer, at)
      }
      this.touch(record, writer, at)
      await this.save(state)
      await this.collectBlobs(state)
      return { name: input.name, status: record.status, revision: record.revision }
    })
  }

  /**
   * Applies or discards a pending proposal. The owner may always; the bot only applies when its changes take effect
   * without approval (review "auto", skill not locked), which lets it adopt a memory-review suggestion.
   */
  async resolveProposal(
    input: { name: string; action: 'apply' | 'discard' },
    writer: BotSkillWriter,
    expectRevision?: number
  ): Promise<{ name: string; status: BotSkillStatus | 'discarded'; revision: number }> {
    return this.exclusive(async () => {
      const state = await this.load()
      const record = this.own(state, input.name)
      if (expectRevision !== undefined) this.expect(record, expectRevision)
      if (!record.proposal) throw new BotSkillError(`Skill "${input.name}" has no pending proposal.`, 'not-found')
      const at = this.now()
      if (input.action === 'discard') {
        await this.removeArea('proposals', input.name)
        delete record.proposal
        if (record.status === 'proposed') {
          delete state.skills[input.name]
          await this.save(state)
          return { name: input.name, status: 'discarded', revision: record.revision }
        }
        this.touch(record, writer, at, false)
        await this.save(state)
        return { name: input.name, status: record.status, revision: record.revision }
      }
      if (writer.actor !== 'owner' && (state.review === 'approve' || record.locked))
        throw new BotSkillError(
          record.locked
            ? `Your owner locked the skill "${input.name}": the proposal waits for them.`
            : 'Your owner reviews your skill changes: the proposal waits for them.',
          'locked'
        )
      if (record.status === 'archived')
        throw new BotSkillError(`Restore "${input.name}" before applying its proposal.`, 'conflict')
      const files = await this.readFiles('proposals', input.name)
      this.assertFiles(input.name, files)
      if (
        record.status === 'proposed' &&
        Object.values(state.skills).filter((item) => item.status === 'active').length >= BOT_SKILL_LIMITS.activeSkills
      )
        throw new BotSkillError(
          `There are ${BOT_SKILL_LIMITS.activeSkills} active skills already; archive one first.`,
          'limit'
        )
      await this.replaceArea('library', input.name, files)
      await this.removeArea('proposals', input.name)
      const proposedBy = record.proposal.actor
      delete record.proposal
      record.status = 'active'
      if (record.createdBy !== proposedBy && record.versions.length === 0) record.createdBy = proposedBy
      await this.addVersion(record, files, 'approve', writer, at)
      this.touch(record, writer, at)
      record.lastEditedBy = proposedBy
      await this.save(state)
      await this.collectBlobs(state)
      return { name: input.name, status: record.status, revision: record.revision }
    })
  }

  // ---- what only the owner does ----

  async setReview(review: BotSkillReview): Promise<BotSkillReview> {
    return this.exclusive(async () => {
      const state = await this.load()
      state.review = review
      await this.save(state)
      return review
    })
  }

  async setLocked(name: string, locked: boolean, revision: number): Promise<number> {
    return this.exclusive(async () => {
      const state = await this.load()
      const record = this.own(state, name)
      this.expect(record, revision)
      record.locked = locked
      record.revision += 1
      await this.save(state)
      return record.revision
    })
  }

  /** Puts a version's files back in effect, as a new version: going back can itself be undone. */
  async revert(name: string, versionId: string, revision: number, writer: BotSkillWriter): Promise<number> {
    return this.exclusive(async () => {
      const state = await this.load()
      const record = this.own(state, name)
      this.expect(record, revision)
      if (record.status !== 'active') throw new BotSkillError(`Restore "${name}" before reverting it.`, 'conflict')
      const version = record.versions.find((item) => item.id === versionId)
      if (!version) throw new BotSkillError(`Skill "${name}" has no version ${versionId}.`, 'not-found')
      const files = await this.blobFiles(version.files)
      this.assertFiles(name, files)
      const at = this.now()
      await this.replaceArea('library', name, files)
      await this.addVersion(record, files, 'revert', writer, at)
      this.touch(record, writer, at)
      await this.save(state)
      await this.collectBlobs(state)
      return record.revision
    })
  }

  /** Deletes a skill forever, with its versions. Only the owner can. */
  async remove(name: string, revision: number): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.load()
      const record = this.own(state, name)
      this.expect(record, revision)
      for (const area of ['library', 'archive', 'proposals'] as const) await this.removeArea(area, name)
      delete state.skills[name]
      delete state.usage[name]
      await this.save(state)
      await this.collectBlobs(state)
    })
  }

  /** The owner's own edit of one file, in effect at once. */
  async ownerWriteFile(
    input: { name: string; filePath: string; content?: string; delete?: boolean; revision: number },
    reason?: string
  ): Promise<BotSkillWriteResult> {
    return this.writeFile(input, { actor: 'owner', reason }, input.revision)
  }

  // ---- internals ----

  /** One change of one file of an own skill, applied or proposed, from what the writer last read. */
  private async change(
    name: string,
    writer: BotSkillWriter,
    file: string,
    edit: (files: Files) => BotSkillAction,
    options: { newFileNeedsNoRead?: boolean; expectRevision?: number } = {}
  ): Promise<BotSkillWriteResult> {
    return this.exclusive(async () => {
      const state = await this.load()
      const record = this.own(state, name)
      if (options.expectRevision !== undefined) this.expect(record, options.expectRevision)
      if (record.status === 'archived')
        throw new BotSkillError(`Skill "${name}" is archived; restore it with skill_archive (restore: true) first.`)
      const proposal =
        writer.actor !== 'owner' &&
        (writer.actor === 'memory-review' ||
          state.review === 'approve' ||
          record.locked ||
          Boolean(record.proposal) ||
          record.status === 'proposed')
      if (writer.actor === 'owner' && record.status === 'proposed')
        throw new BotSkillError(`"${name}" is only a proposal: approve or discard it.`, 'conflict')
      const source: Area = proposal && record.proposal ? 'proposals' : 'library'
      const files = await this.readFiles(source, name)
      const current = files.get(file)
      if (writer.actor === 'bot' && writer.conversationId && !(current === undefined && options.newFileNeedsNoRead)) {
        const seen = this.reads.get(writer.conversationId)?.get(`${name}/${file}`)
        if (seen === undefined)
          throw new BotSkillError(
            `Read ${file} of "${name}" with skill_view in this conversation before changing it.`,
            'read-first'
          )
        if (current !== undefined && seen !== sha(current))
          throw new BotSkillError(
            `${file} of "${name}" changed since you read it. Read it again with skill_view, then make your change.`,
            'stale-read'
          )
      }
      const action = edit(files)
      const written = files.get(file)
      if (written !== undefined)
        file === SKILL_MD
          ? assertSkillMarkdown(name, written)
          : assertSkillText(file, written, BOT_SKILL_LIMITS.fileBytes)
      this.assertFiles(name, files)
      const at = this.now()
      if (proposal) {
        if (!record.proposal) {
          this.assertProposalRoom(state, name)
          record.proposal = this.newProposal(writer, at, record.revision)
        } else {
          record.proposal.updatedAt = at
          record.proposal.actor = writer.actor
          const reason = reasonText(writer.reason)
          if (reason) record.proposal.reason = reason
        }
        await this.replaceArea('proposals', name, files)
        record.revision += 1
      } else {
        await this.replaceArea('library', name, files)
        await this.addVersion(record, files, action, writer, at)
        this.touch(record, writer, at)
      }
      await this.save(state)
      if (writer.conversationId) {
        if (written === undefined) this.reads.get(writer.conversationId)?.delete(`${name}/${file}`)
        else this.noteRead(writer.conversationId, name, file, written)
      }
      if (!proposal) await this.collectBlobs(state)
      const markdown = files.get(SKILL_MD) ?? ''
      return {
        name,
        applied: proposal ? 'proposal' : 'library',
        path: file,
        revision: record.revision,
        advice: file === SKILL_MD ? descriptionAdvice(parseSkillFrontmatter(markdown).fields.description ?? '') : [],
      }
    })
  }

  private assertProposalRoom(state: State, name: string): void {
    const pending = Object.entries(state.skills).filter(([other, record]) => other !== name && record.proposal).length
    if (pending >= BOT_SKILL_LIMITS.proposals)
      throw new BotSkillError(
        `${BOT_SKILL_LIMITS.proposals} skill proposals already wait for your owner; wait for them to review some.`,
        'limit'
      )
  }

  private newProposal(writer: BotSkillWriter, at: number, baseRevision: number): BotSkillProposal {
    return {
      actor: writer.actor,
      reason: reasonText(writer.reason),
      createdAt: at,
      updatedAt: at,
      ...(writer.conversationId ? { conversationId: writer.conversationId } : {}),
      baseRevision,
    }
  }

  private assertFiles(name: string, files: Files): void {
    if (!files.has(SKILL_MD)) throw new BotSkillError(`Skill "${name}" needs its ${SKILL_MD}.`)
    if (files.size > BOT_SKILL_LIMITS.filesPerSkill)
      throw new BotSkillError(`A skill keeps at most ${BOT_SKILL_LIMITS.filesPerSkill} files.`, 'limit')
    let bytes = 0
    for (const content of files.values()) bytes += Buffer.byteLength(content, 'utf8')
    if (bytes > BOT_SKILL_LIMITS.bytesPerSkill)
      throw new BotSkillError(
        `A skill keeps at most ${BOT_SKILL_LIMITS.bytesPerSkill / 1024 / 1024} MiB of files.`,
        'limit'
      )
  }

  private touch(record: SkillRecord, writer: BotSkillWriter, at: number, edited = true): void {
    record.revision += 1
    record.updatedAt = at
    if (edited) record.lastEditedBy = writer.actor
  }

  private expect(record: SkillRecord, revision: number): void {
    if (record.revision !== revision)
      throw new BotSkillError('The skill changed since you opened it. Reload it and try again.', 'conflict')
  }

  private own(state: State, name: string): SkillRecord {
    const record = BOT_SKILL_NAME.test(name) ? state.skills[name] : undefined
    if (!record)
      throw new BotSkillError(
        `"${name}" is not one of your own skills. You can change only the skills you created; create one with skill_create.`,
        'not-own'
      )
    return record
  }

  private viewArea(record: SkillRecord): Area {
    return record.proposal ? 'proposals' : record.status === 'archived' ? 'archive' : 'library'
  }

  private summary(name: string, record: SkillRecord, state: State, files: Files): BotSkillSummary {
    const usage = state.usage[name]
    return {
      name,
      description: (parseSkillFrontmatter(files.get(SKILL_MD) ?? '').fields.description ?? '').trim(),
      status: record.status,
      createdBy: record.createdBy,
      lastEditedBy: record.lastEditedBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
      locked: record.locked,
      files: files.size,
      hasScripts: [...files.keys()].some((file) => file.startsWith('scripts/')),
      uses: usage?.count ?? 0,
      lastUsedAt: usage?.lastUsedAt ?? null,
      ...(record.absorbedInto ? { absorbedInto: record.absorbedInto } : {}),
      proposal: record.proposal ?? null,
    }
  }

  private noteRead(conversationId: string, name: string, file: string, content: string): void {
    let seen = this.reads.get(conversationId)
    if (!seen) this.reads.set(conversationId, (seen = new Map()))
    seen.set(`${name}/${file}`, sha(content))
  }

  private async addVersion(
    record: SkillRecord,
    files: Files,
    action: BotSkillAction,
    writer: BotSkillWriter,
    at: number
  ): Promise<void> {
    const manifest: Record<string, string> = {}
    for (const [file, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const digest = sha(content)
      manifest[file] = digest
      await this.writeBlob(digest, content)
    }
    record.versions.push({
      id: randomUUID(),
      at,
      actor: writer.actor,
      action,
      reason: reasonText(writer.reason),
      ...(writer.conversationId ? { conversationId: writer.conversationId } : {}),
      files: manifest,
    })
    if (record.versions.length > BOT_SKILL_LIMITS.versionsPerSkill)
      record.versions.splice(0, record.versions.length - BOT_SKILL_LIMITS.versionsPerSkill)
  }

  private async writeBlob(digest: string, content: string): Promise<void> {
    const target = path.join(await this.safeDir('blobs'), digest)
    if (
      await fsp.lstat(target).then(
        (stat) => stat.isFile(),
        () => false
      )
    )
      return
    await atomicWrite(target, content)
  }

  private async blobFiles(manifest: Record<string, string>): Promise<Files> {
    const files: Files = new Map()
    const blobs = await this.safeDir('blobs')
    for (const [file, digest] of Object.entries(manifest)) {
      const content = await fsp.readFile(path.join(blobs, digest), 'utf8').catch(() => null)
      if (content === null || sha(content) !== digest)
        throw new BotSkillError(`A saved version of ${file} is missing or damaged.`, 'damaged')
      files.set(file, content)
    }
    return files
  }

  /** Deletes the blobs no version still refers to. */
  private async collectBlobs(state: State): Promise<void> {
    const keep = new Set<string>()
    for (const record of Object.values(state.skills))
      for (const version of record.versions) for (const digest of Object.values(version.files)) keep.add(digest)
    const blobs = await this.safeDir('blobs')
    for (const entry of await fsp.readdir(blobs, { withFileTypes: true }).catch(() => []))
      if (entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !keep.has(entry.name))
        await fsp.rm(path.join(blobs, entry.name), { force: true })
  }

  private areaDir(area: Area): string {
    return path.join(this.root, area)
  }
  private dir(area: Area, name: string): string {
    return path.join(this.root, area, name)
  }

  /** A folder under the skills root, created when missing; no link anywhere from the root down. */
  private async safeDir(...segments: string[]): Promise<string> {
    let current = this.root
    for (const segment of ['', ...segments]) {
      if (segment) current = path.join(current, segment)
      const stat = await fsp.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!stat) await fsp.mkdir(current, { recursive: true })
      else if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new BotSkillError('The skills folder holds a link or an unexpected file; nothing was changed.', 'unsafe')
    }
    return current
  }

  private async isRealDir(target: string): Promise<boolean> {
    return fsp.lstat(target).then(
      (stat) => stat.isDirectory() && !stat.isSymbolicLink(),
      () => false
    )
  }

  /** The regular files of a skill folder, by relative path. Links are never followed. */
  private async readFiles(area: Area, name: string): Promise<Files> {
    const files: Files = new Map()
    const base = this.dir(area, name)
    if (!(await this.isRealDir(base))) return files
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > BOT_SKILL_LIMITS.pathDepth) return
      for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(absolute, relative, depth + 1)
        else if (entry.isFile() && files.size < BOT_SKILL_LIMITS.filesPerSkill * 2) {
          const stat = await fsp.lstat(absolute)
          if (stat.size > BOT_SKILL_LIMITS.fileBytes) continue
          files.set(relative, await fsp.readFile(absolute, 'utf8'))
        }
      }
    }
    await walk(base, '', 1)
    return files
  }

  /** Makes a skill folder hold exactly `files`: changed files are rewritten atomically, the others removed. */
  private async replaceArea(area: Area, name: string, files: Files): Promise<void> {
    await this.safeDir(area)
    const base = await this.safeDir(area, name)
    const current = await this.readFiles(area, name)
    for (const [file, content] of files) {
      if (current.get(file) === content) continue
      const parts = file.split('/')
      const dir = parts.length > 1 ? await this.safeDir(area, name, ...parts.slice(0, -1)) : base
      const target = path.join(dir, parts[parts.length - 1])
      const stat = await fsp.lstat(target).catch(() => null)
      if (stat && !stat.isFile())
        throw new BotSkillError(`${file} is not a regular file in the skill folder; nothing was changed.`, 'unsafe')
      await atomicWrite(target, content, file.startsWith('scripts/') ? 0o700 : 0o600)
    }
    for (const file of current.keys()) if (!files.has(file)) await fsp.rm(path.join(base, file), { force: true })
    await removeEmptyDirs(base)
  }

  private async removeArea(area: Area, name: string): Promise<void> {
    const target = this.dir(area, name)
    const stat = await fsp.lstat(target).catch(() => null)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      await fsp.unlink(target)
      return
    }
    await this.safeDir(area)
    await fsp.rm(target, { recursive: true, force: true })
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(operation)
    this.chain = next
    return next
  }

  /** The current state, read once and then kept; waits for changes in progress. */
  private async read(): Promise<State> {
    return this.exclusive(() => this.load())
  }

  private async load(): Promise<State> {
    if (this.state) return this.state
    await this.safeDir()
    const file = path.join(this.root, 'state.json')
    const raw = await fsp.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    let state: State | null = null
    if (raw !== null) {
      try {
        const parsed = stateSchema.safeParse(JSON.parse(raw))
        if (parsed.success) state = parsed.data
      } catch {
        state = null
      }
      if (!state) {
        // Kept aside for the owner; the folders still hold every skill, so the state is rebuilt from them.
        await fsp.rename(file, path.join(this.root, `state.damaged-${this.now()}.json`)).catch(() => undefined)
        console.warn('[bot-skills] Damaged skill state set aside; rebuilt from the skill folders')
      }
    }
    const loaded = state ?? { version: 1 as const, review: 'auto' as const, skills: {}, usage: {} }
    const changed = await this.reconcile(loaded)
    this.state = loaded
    if (changed || raw === null || !state) await this.save(loaded)
    return loaded
  }

  /** Records skill folders the state does not know (and forgets records whose folders are gone, keeping versions). */
  private async reconcile(state: State): Promise<boolean> {
    let changed = false
    const at = this.now()
    const present = async (area: Area) =>
      (await fsp.readdir(this.areaDir(area), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && BOT_SKILL_NAME.test(entry.name))
        .map((entry) => entry.name)
    const library = new Set(await present('library'))
    const archive = new Set(await present('archive'))
    const proposals = new Set(await present('proposals'))
    const blank = (status: BotSkillStatus): SkillRecord => ({
      status,
      createdBy: 'bot',
      lastEditedBy: 'bot',
      createdAt: at,
      updatedAt: at,
      revision: 1,
      locked: false,
      versions: [],
    })
    for (const name of library)
      if (!state.skills[name]) {
        state.skills[name] = blank('active')
        changed = true
      }
    for (const name of archive)
      if (!state.skills[name]) {
        state.skills[name] = blank('archived')
        changed = true
      }
    for (const name of proposals)
      if (!state.skills[name]) {
        state.skills[name] = { ...blank('proposed'), proposal: this.newProposal({ actor: 'bot' }, at, 0) }
        changed = true
      }
    for (const [name, record] of Object.entries(state.skills)) {
      if (record.proposal && !proposals.has(name)) {
        delete record.proposal
        changed = true
      }
      if (record.status === 'proposed' && !proposals.has(name)) {
        delete state.skills[name]
        changed = true
      } else if (record.status === 'active' && !library.has(name)) {
        if (record.versions.length) record.status = 'archived'
        else delete state.skills[name]
        changed = true
      }
    }
    return changed
  }

  private async save(state: State): Promise<void> {
    this.state = state
    await atomicWrite(path.join(await this.safeDir(), 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  }
}

function sortedFiles(files: Files): BotSkillFile[] {
  return [...files]
    .sort(([a], [b]) => (a === SKILL_MD ? -1 : b === SKILL_MD ? 1 : a.localeCompare(b)))
    .map(([file, content]) => ({ path: file, content }))
}

/** Temporary names end in `.tmp`, which a bot move never carries. */
async function atomicWrite(target: string, content: string, mode = 0o600): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' })
    await fsp.rename(temporary, target)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeEmptyDirs(dir: string): Promise<boolean> {
  let empty = true
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && (await removeEmptyDirs(path.join(dir, entry.name)))) {
      await fsp.rmdir(path.join(dir, entry.name)).catch(() => undefined)
      continue
    }
    empty = false
  }
  return empty
}
