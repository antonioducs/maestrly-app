import { z } from 'zod'

/**
 * Gateway feature (`moreFeatures` of `/v1/meta`) and instance capability: the owner lists, reads, edits, reverts,
 * archives, locks and deletes the skills a bot keeps for itself, approves or discards its proposals and chooses whether
 * its changes wait for review (`botOwnSkills*`).
 */
export const FLEET_BOT_OWN_SKILLS_FEATURE = 'bot-own-skills'

export const FLEET_BOT_OWN_SKILL_LIMITS = {
  nameMax: 64,
  descriptionMax: 1_024,
  skillMdBytes: 64 * 1024,
  fileBytes: 256 * 1024,
  filesPerSkill: 40,
  pathMax: 240,
  reasonMax: 300,
  versionsPerSkill: 20,
  /** Every skill a bot keeps, archived ones and proposals included. */
  skillsMax: 300,
} as const

export const fleetBotOwnSkillNameSchema = z
  .string()
  .max(FLEET_BOT_OWN_SKILL_LIMITS.nameMax)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
/** `SKILL.md`, or a file under one of a skill's resource folders, with plain segments only. */
export const fleetBotOwnSkillPathSchema = z
  .string()
  .max(FLEET_BOT_OWN_SKILL_LIMITS.pathMax)
  .regex(/^(?:SKILL\.md|(?:scripts|templates|references|assets)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*){1,4})$/)
export const fleetBotOwnSkillActorSchema = z.enum(['bot', 'owner', 'memory-review'])
export type FleetBotOwnSkillActor = z.infer<typeof fleetBotOwnSkillActorSchema>
export const fleetBotOwnSkillStatusSchema = z.enum(['active', 'archived', 'proposed'])
export const fleetBotOwnSkillReviewSchema = z.enum(['auto', 'approve'])
export type FleetBotOwnSkillReview = z.infer<typeof fleetBotOwnSkillReviewSchema>
export const fleetBotOwnSkillVersionActionSchema = z.enum([
  'create',
  'patch',
  'write-file',
  'remove-file',
  'revert',
  'archive',
  'restore',
  'approve',
])

const time = z.number().int().nonnegative()
const reason = z.string().max(FLEET_BOT_OWN_SKILL_LIMITS.reasonMax)
const revision = z.number().int().nonnegative()

export const fleetBotOwnSkillProposalSchema = z
  .object({
    actor: fleetBotOwnSkillActorSchema,
    reason,
    createdAt: time,
    updatedAt: time,
    /** The skill's revision when the proposal started. */
    baseRevision: revision,
  })
  .strict()
export const fleetBotOwnSkillSummarySchema = z
  .object({
    name: fleetBotOwnSkillNameSchema,
    description: z.string().max(FLEET_BOT_OWN_SKILL_LIMITS.descriptionMax),
    status: fleetBotOwnSkillStatusSchema,
    createdBy: fleetBotOwnSkillActorSchema,
    lastEditedBy: fleetBotOwnSkillActorSchema,
    createdAt: time,
    updatedAt: time,
    revision,
    locked: z.boolean(),
    files: z.number().int().nonnegative(),
    hasScripts: z.boolean(),
    uses: z.number().int().nonnegative(),
    lastUsedAt: time.nullable(),
    absorbedInto: fleetBotOwnSkillNameSchema.optional(),
    /** An installed skill of the environment or a plugin has the same name, and is the one the bot finds. */
    shadowed: z.boolean(),
    proposal: fleetBotOwnSkillProposalSchema.nullable(),
  })
  .strict()
export type FleetBotOwnSkillSummary = z.infer<typeof fleetBotOwnSkillSummarySchema>

export const fleetBotOwnSkillsListSchema = z
  .object({
    review: fleetBotOwnSkillReviewSchema,
    skills: z.array(fleetBotOwnSkillSummarySchema).max(FLEET_BOT_OWN_SKILL_LIMITS.skillsMax),
  })
  .strict()
export type FleetBotOwnSkillsList = z.infer<typeof fleetBotOwnSkillsListSchema>
export const fleetBotOwnSkillsSettingsSchema = z.object({ review: fleetBotOwnSkillReviewSchema }).strict()
export type FleetBotOwnSkillsSettings = z.infer<typeof fleetBotOwnSkillsSettingsSchema>

export const fleetBotOwnSkillFileSchema = z
  .object({ path: fleetBotOwnSkillPathSchema, content: z.string().max(FLEET_BOT_OWN_SKILL_LIMITS.fileBytes) })
  .strict()
export type FleetBotOwnSkillFile = z.infer<typeof fleetBotOwnSkillFileSchema>
const files = z.array(fleetBotOwnSkillFileSchema).max(FLEET_BOT_OWN_SKILL_LIMITS.filesPerSkill * 2)
export const fleetBotOwnSkillVersionSchema = z
  .object({
    id: z.string().min(1).max(64),
    at: time,
    actor: fleetBotOwnSkillActorSchema,
    action: fleetBotOwnSkillVersionActionSchema,
    reason,
    paths: z.array(fleetBotOwnSkillPathSchema).max(FLEET_BOT_OWN_SKILL_LIMITS.filesPerSkill * 2),
  })
  .strict()
export type FleetBotOwnSkillVersion = z.infer<typeof fleetBotOwnSkillVersionSchema>
export const fleetBotOwnSkillDetailSchema = fleetBotOwnSkillSummarySchema
  .extend({
    /** What is in effect (or archived); empty for a skill that is only a proposal. */
    currentFiles: files,
    proposalFiles: files.nullable(),
    /** Newest first. */
    versions: z.array(fleetBotOwnSkillVersionSchema).max(FLEET_BOT_OWN_SKILL_LIMITS.versionsPerSkill),
  })
  .strict()
export type FleetBotOwnSkillDetail = z.infer<typeof fleetBotOwnSkillDetailSchema>
export const fleetBotOwnSkillVersionFilesSchema = z.object({ files }).strict()
export type FleetBotOwnSkillVersionFiles = z.infer<typeof fleetBotOwnSkillVersionFilesSchema>

/** Every change names the revision the owner saw, so it never overwrites a newer change. */
const action = <A extends string, S extends z.ZodRawShape>(name: A, shape: S) =>
  z.object({ action: z.literal(name), revision, ...shape }).strict()
export const fleetBotOwnSkillActionSchema = z.discriminatedUnion('action', [
  action('write-file', {
    path: fleetBotOwnSkillPathSchema,
    content: z.string().max(FLEET_BOT_OWN_SKILL_LIMITS.fileBytes),
  }),
  action('remove-file', { path: fleetBotOwnSkillPathSchema }),
  action('revert', { versionId: z.string().min(1).max(64) }),
  action('archive', {}),
  action('restore', {}),
  action('delete', {}),
  action('approve', {}),
  action('discard', {}),
  action('lock', {}),
  action('unlock', {}),
])
export type FleetBotOwnSkillAction = z.infer<typeof fleetBotOwnSkillActionSchema>
/** The skill after the change; null once it is gone (deleted, or a new skill's proposal discarded). */
export const fleetBotOwnSkillActionResultSchema = z.object({ skill: fleetBotOwnSkillDetailSchema.nullable() }).strict()
export type FleetBotOwnSkillActionResult = z.infer<typeof fleetBotOwnSkillActionResultSchema>
