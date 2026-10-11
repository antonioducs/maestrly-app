import {
  FLEET_NAME_MAX,
  FLEET_ROLE_MAX,
  type FleetBot,
  type FleetCompactionConfig,
  type FleetPatchBotRequest,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import {
  compactionFormFrom,
  compactionIntervalTokens,
  compactionPatch,
  compactionSourceOf,
  ENVIRONMENT_COMPACTION_CHOICE,
  sameCompactionConfig,
  type CompactionForm,
} from './compaction'
import type { Ceiling } from './forms'

/**
 * What a bot does without asking at each ceiling, one row per kind of action, in the order the settings show them.
 * A test checks every cell against the permission rulesets the bot's conversation runs with.
 */
export const autonomyCapabilities = [
  { id: 'read', allowed: ['ask', 'auto', 'full'] },
  { id: 'edit', allowed: ['auto', 'full'] },
  { id: 'web', allowed: ['auto', 'full'] },
  { id: 'commands', allowed: ['full'] },
  { id: 'outside', allowed: ['full'] },
] as const satisfies ReadonlyArray<{ id: string; allowed: readonly Ceiling[] }>
export type AutonomyCapability = (typeof autonomyCapabilities)[number]['id']

/** The capabilities a ceiling allows on its own and those it asks the owner about, in table order. */
export function autonomyAt(ceiling: Ceiling): { alone: AutonomyCapability[]; asks: AutonomyCapability[] } {
  const allows = (row: (typeof autonomyCapabilities)[number]) => (row.allowed as readonly Ceiling[]).includes(ceiling)
  return {
    alone: autonomyCapabilities.filter(allows).map((row) => row.id),
    asks: autonomyCapabilities.filter((row) => !allows(row)).map((row) => row.id),
  }
}

/** The settings that wait for the save button, as the owner edits them. */
export type BotSettingsDraft = {
  name: string
  role: string
  instructions: string
  ceiling: Ceiling
  publishArtifacts: boolean
  talksTo: string[]
  selectionId: string
  compaction: CompactionForm
}
export type BotSettingsField =
  | 'publishArtifacts'
  | 'name'
  | 'role'
  | 'instructions'
  | 'ceiling'
  | 'selection'
  | 'compaction'
  | 'talksTo'
/** Every field that waits for the save button, in page order, with the section that holds it. */
export const botSettingsFields = [
  { id: 'name', section: 'identity' },
  { id: 'role', section: 'identity' },
  { id: 'instructions', section: 'identity' },
  { id: 'ceiling', section: 'autonomy' },
  { id: 'publishArtifacts', section: 'autonomy' },
  { id: 'selection', section: 'model' },
  { id: 'compaction', section: 'model' },
  { id: 'talksTo', section: 'peers' },
] as const satisfies ReadonlyArray<{ id: BotSettingsField; section: string }>

export function selectionIdOf(bot: Pick<FleetBot, 'selection'>): string {
  return bot.selection ? `${bot.selection.providerId}::${bot.selection.modelId}` : ''
}

/**
 * The draft a bot's settings start from. With environment defaults (`inheritable`), a bot without a compaction model
 * of its own shows its environment's default as its choice.
 */
export function botSettingsDraft(bot: FleetBot, inheritable: boolean): BotSettingsDraft {
  const compaction = compactionFormFrom(bot.compaction)
  return {
    name: bot.name,
    role: bot.role,
    instructions: bot.instructions,
    ceiling: bot.ceiling,
    publishArtifacts: bot.publishArtifacts ?? false,
    talksTo: [...bot.talksTo],
    selectionId: selectionIdOf(bot),
    compaction:
      inheritable && compactionSourceOf(bot) !== 'bot'
        ? { ...compaction, modelId: ENVIRONMENT_COMPACTION_CHOICE }
        : compaction,
  }
}

/**
 * The draft after the bot changed elsewhere (an event, another device): a field the owner has not edited follows the
 * bot, one they edited keeps their value.
 */
export function rebaseBotSettingsDraft(
  draft: BotSettingsDraft,
  previous: BotSettingsDraft,
  next: BotSettingsDraft
): BotSettingsDraft {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const pick = <K extends keyof BotSettingsDraft>(key: K): BotSettingsDraft[K] =>
    same(draft[key], previous[key]) ? next[key] : draft[key]
  return {
    name: pick('name'),
    role: pick('role'),
    instructions: pick('instructions'),
    ceiling: pick('ceiling'),
    publishArtifacts: pick('publishArtifacts'),
    talksTo: sortedIds(draft.talksTo) === sortedIds(previous.talksTo) ? next.talksTo : draft.talksTo,
    selectionId: pick('selectionId'),
    compaction: pick('compaction'),
  }
}

/**
 * What saving the compaction form would change. Inheriting saves null: the bot then follows its environment's
 * default, whatever it becomes. A form that is not a valid model and interval has no value.
 */
export function compactionChange(
  bot: Pick<FleetBot, 'compaction' | 'compactionSource'>,
  form: CompactionForm,
  inheritable: boolean
): { dirty: boolean; valid: boolean; inherits: boolean; value: FleetCompactionConfig | null } {
  const inherits = inheritable && form.modelId === ENVIRONMENT_COMPACTION_CHOICE
  const value = inherits ? null : compactionPatch(form)
  const source = compactionSourceOf(bot)
  const dirty = !inheritable
    ? !sameCompactionConfig(value, bot.compaction)
    : inherits
      ? source === 'bot'
      : source !== 'bot' || !sameCompactionConfig(value, bot.compaction)
  return { dirty, valid: inherits || value !== null, inherits, value }
}

const sortedIds = (ids: readonly string[]) => JSON.stringify([...ids].sort())

/** The fields whose draft differs from the bot, in page order. */
export function changedBotSettings(bot: FleetBot, draft: BotSettingsDraft, inheritable: boolean): BotSettingsField[] {
  const changed: Record<BotSettingsField, boolean> = {
    name: draft.name.trim() !== bot.name.trim(),
    role: draft.role.trim() !== bot.role.trim(),
    instructions: draft.instructions.trim() !== bot.instructions.trim(),
    ceiling: draft.ceiling !== bot.ceiling,
    publishArtifacts: draft.publishArtifacts !== (bot.publishArtifacts ?? false),
    selection: draft.selectionId !== selectionIdOf(bot),
    compaction: compactionChange(bot, draft.compaction, inheritable).dirty,
    talksTo: sortedIds(draft.talksTo) !== sortedIds(bot.talksTo),
  }
  return botSettingsFields.filter((field) => changed[field.id]).map((field) => field.id)
}

export type BotSettingsProblem = 'name' | 'role' | 'compactionModel' | 'compactionInterval' | 'compactionContextLimit'

/** What keeps the draft from being saved, in page order. */
export function botSettingsProblems(
  bot: FleetBot,
  draft: BotSettingsDraft,
  inheritable: boolean
): BotSettingsProblem[] {
  const problems: BotSettingsProblem[] = []
  if (!draft.name.trim() || draft.name.length > FLEET_NAME_MAX) problems.push('name')
  if (draft.role.length > FLEET_ROLE_MAX) problems.push('role')
  const compaction = compactionChange(bot, draft.compaction, inheritable)
  if (compaction.dirty && !compaction.valid)
    problems.push(
      !draft.compaction.modelId
        ? 'compactionModel'
        : compactionIntervalTokens(draft.compaction) === null
          ? 'compactionInterval'
          : 'compactionContextLimit'
    )
  return problems
}

/**
 * The request that saves the draft: only the fields that changed, so that a change to one setting never rewrites
 * another. A new main model starts without reasoning or Fast mode, which the conversation's composer sets.
 */
export function botSettingsPatch(
  bot: FleetBot,
  draft: BotSettingsDraft,
  inheritable: boolean,
  options: readonly FleetSelectionOption[]
): FleetPatchBotRequest {
  const patch: FleetPatchBotRequest = {}
  for (const field of changedBotSettings(bot, draft, inheritable)) {
    if (field === 'name') patch.name = draft.name.trim()
    else if (field === 'role') patch.role = draft.role.trim()
    else if (field === 'instructions') patch.instructions = draft.instructions.trim()
    else if (field === 'ceiling') patch.ceiling = draft.ceiling
    else if (field === 'publishArtifacts') patch.publishArtifacts = draft.publishArtifacts
    else if (field === 'talksTo') patch.talksTo = [...draft.talksTo]
    else if (field === 'compaction') patch.compaction = compactionChange(bot, draft.compaction, inheritable).value
    else {
      const chosen = options.find((option) => option.id === draft.selectionId)
      patch.selection = chosen
        ? { providerId: chosen.providerId, modelId: chosen.modelId, reasoning: null, fastMode: false }
        : null
    }
  }
  return patch
}
