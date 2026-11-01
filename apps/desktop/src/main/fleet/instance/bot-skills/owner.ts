import {
  FLEET_BOT_OWN_SKILL_LIMITS,
  fleetBotOwnSkillPathSchema,
  type FleetBotOwnSkillAction,
  type FleetBotOwnSkillActionResult,
  type FleetBotOwnSkillDetail,
  type FleetBotOwnSkillFile,
  type FleetBotOwnSkillSummary,
  type FleetBotOwnSkillsList,
  type FleetBotOwnSkillVersionFiles,
} from '@maestrly/bot-fleet-protocol'
import { InstanceHttpError } from '../http'
import type { BotSkillDetail, BotSkillFile, BotSkillStore, BotSkillSummary } from './store'
import { BotSkillError } from './validation'

/**
 * The owner's side of a bot's own skills, as the control API serves it: what the store keeps, in the protocol's shapes,
 * and the owner's changes, each against the revision the owner saw.
 */
export class BotSkillOwnerApi {
  constructor(
    private readonly store: BotSkillStore,
    /** Names of the skills the bot's conversations find from other sources, which hide the bot's own. */
    private readonly installedNames: () => Promise<ReadonlySet<string>>
  ) {}

  async list(): Promise<FleetBotOwnSkillsList> {
    return owner(async () => {
      const installed = await this.installedNames()
      const skills = await this.store.list()
      return {
        review: await this.store.review(),
        skills: skills.slice(0, FLEET_BOT_OWN_SKILL_LIMITS.skillsMax).map((skill) => summary(skill, installed)),
      }
    })
  }

  async setReview(review: 'auto' | 'approve'): Promise<FleetBotOwnSkillsList> {
    await owner(() => this.store.setReview(review))
    return this.list()
  }

  async detail(name: string): Promise<FleetBotOwnSkillDetail> {
    return owner(async () => detail(await this.store.detail(name), await this.installedNames()))
  }

  async version(name: string, versionId: string): Promise<FleetBotOwnSkillVersionFiles> {
    return owner(async () => ({ files: files(await this.store.versionFiles(name, versionId)) }))
  }

  async act(name: string, request: FleetBotOwnSkillAction): Promise<FleetBotOwnSkillActionResult> {
    return owner(async () => {
      const writer = { actor: 'owner' as const }
      const { revision } = request
      switch (request.action) {
        case 'write-file':
          await this.store.ownerWriteFile({ name, filePath: request.path, content: request.content, revision })
          break
        case 'remove-file':
          await this.store.ownerWriteFile({ name, filePath: request.path, delete: true, revision })
          break
        case 'revert':
          await this.store.revert(name, request.versionId, revision, writer)
          break
        case 'archive':
        case 'restore':
          await this.store.archive({ name, restore: request.action === 'restore' }, writer, revision)
          break
        case 'approve':
        case 'discard': {
          const result = await this.store.resolveProposal(
            { name, action: request.action === 'approve' ? 'apply' : 'discard' },
            writer,
            revision
          )
          if (result.status === 'discarded') return { skill: null }
          break
        }
        case 'lock':
        case 'unlock':
          await this.store.setLocked(name, request.action === 'lock', revision)
          break
        case 'delete':
          await this.store.remove(name, revision)
          return { skill: null }
      }
      return { skill: detail(await this.store.detail(name), await this.installedNames()) }
    })
  }
}

/** Store refusals as the control API answers them; their text speaks to the bot, so the owner gets its own. */
async function owner<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof BotSkillError)) throw error
    switch (error.code) {
      case 'not-found':
      case 'not-own':
        throw new InstanceHttpError(404, 'NOT_FOUND', 'The bot has no such skill or version.')
      case 'conflict':
      case 'stale-read':
        throw new InstanceHttpError(
          409,
          'CONFLICT',
          error.message.includes('changed since')
            ? 'The skill changed since you opened it. Reload it and try again.'
            : 'The skill is not in a state that allows this change. Reload it and try again.'
        )
      case 'locked':
      case 'exists':
        throw new InstanceHttpError(409, 'CONFLICT', error.message)
      case 'damaged':
        throw new InstanceHttpError(409, 'CONFLICT', 'A saved version of this skill is missing or damaged.')
      default:
        throw new InstanceHttpError(400, 'INVALID_REQUEST', error.message)
    }
  }
}

const description = (text: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, FLEET_BOT_OWN_SKILL_LIMITS.descriptionMax)
const validPath = (path: string) => fleetBotOwnSkillPathSchema.safeParse(path).success

function summary(skill: BotSkillSummary, installed: ReadonlySet<string>): FleetBotOwnSkillSummary {
  return {
    name: skill.name,
    description: description(skill.description),
    status: skill.status,
    createdBy: skill.createdBy,
    lastEditedBy: skill.lastEditedBy,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    revision: skill.revision,
    locked: skill.locked,
    files: skill.files,
    hasScripts: skill.hasScripts,
    uses: skill.uses,
    lastUsedAt: skill.lastUsedAt,
    ...(skill.absorbedInto ? { absorbedInto: skill.absorbedInto } : {}),
    shadowed: installed.has(skill.name),
    proposal: skill.proposal
      ? {
          actor: skill.proposal.actor,
          reason: skill.proposal.reason,
          createdAt: skill.proposal.createdAt,
          updatedAt: skill.proposal.updatedAt,
          baseRevision: skill.proposal.baseRevision,
        }
      : null,
  }
}

/** Files placed in the folder by other means than the skill tools, at paths a skill does not use, are not shown. */
function files(list: readonly BotSkillFile[]): FleetBotOwnSkillFile[] {
  return list
    .filter((file) => validPath(file.path) && file.content.length <= FLEET_BOT_OWN_SKILL_LIMITS.fileBytes)
    .map((file) => ({ path: file.path, content: file.content }))
}

function detail(skill: BotSkillDetail, installed: ReadonlySet<string>): FleetBotOwnSkillDetail {
  return {
    ...summary(skill, installed),
    currentFiles: files(skill.currentFiles),
    proposalFiles: skill.proposalFiles ? files(skill.proposalFiles) : null,
    versions: skill.versions.map((version) => ({
      id: version.id,
      at: version.at,
      actor: version.actor,
      action: version.action,
      reason: version.reason,
      paths: Object.keys(version.files).filter(validPath).sort(),
    })),
  }
}
