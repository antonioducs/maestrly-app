import { describe, expect, it } from 'vitest'
import { fleetBotSchema, type FleetBot, type FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import {
  AUTO_RULESET,
  BOT_MEMORY_WRITE_RULES,
  BYOK_DEFAULT_RULESET,
  ruleEffect,
  YOLO_RULESET,
  type Ruleset,
} from '../../src/main/chat/permission'
import {
  autonomyAt,
  autonomyCapabilities,
  botSettingsDraft,
  botSettingsPatch,
  botSettingsProblems,
  changedBotSettings,
  compactionChange,
  rebaseBotSettingsDraft,
  type AutonomyCapability,
} from '../../src/renderer/lib/fleet/bot-settings'
import { ENVIRONMENT_COMPACTION_CHOICE } from '../../src/renderer/lib/fleet/compaction'
import { ceilingValues, type Ceiling } from '../../src/renderer/lib/fleet/forms'
import { resources } from '../../src/shared/i18n/resources'

const at = '2026-09-27T12:00:00.000Z'
const modelA = { providerId: 'prov', modelId: 'model-a', reasoning: 'low', fastMode: false, intervalTokens: 120_000 }

function bot(patch: Record<string, unknown> = {}): FleetBot {
  return fleetBotSchema.parse({
    id: 'scout',
    name: 'Scout',
    role: 'Finds orders',
    instructions: 'Check the portal.',
    tint: '#336699',
    ceiling: 'auto',
    selection: { providerId: 'prov', modelId: 'main', reasoning: 'high', fastMode: true },
    talksTo: ['partner', 'diary'],
    paused: false,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    status: 'idle',
    activity: null,
    pendingCount: 0,
    accounts: { connected: true, providers: [] },
    takeover: { state: 'none', deviceId: null, deviceName: null, since: null },
    resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
    screen: { width: 1280, height: 800, display: ':1' },
    appVersion: '1.0.0',
    environmentId: 'acme',
    createdAt: at,
    updatedAt: at,
    ...patch,
  })
}
const option = (providerId: string, modelId: string): FleetSelectionOption =>
  ({
    id: `${providerId}::${modelId}`,
    providerId,
    modelId,
    providerLabel: providerId,
    modelLabel: modelId,
    efforts: [],
    fastMode: false,
  }) as unknown as FleetSelectionOption

describe('bot autonomy table', () => {
  // The conversation of a bot runs with its ceiling's ruleset plus the memory writes it never asks about.
  const rulesets: Record<Ceiling, Ruleset> = {
    ask: [...BYOK_DEFAULT_RULESET, ...BOT_MEMORY_WRITE_RULES],
    auto: [...AUTO_RULESET, ...BOT_MEMORY_WRITE_RULES],
    full: [...YOLO_RULESET, ...BOT_MEMORY_WRITE_RULES],
  }
  // What each row stands for, as permission requests name it.
  const probes: Record<AutonomyCapability, Array<[string, string]>> = {
    read: [
      ['read', 'src/notes.md'],
      ['grep', 'invoice'],
      ['glob', '**/*.csv'],
    ],
    edit: [['edit', 'src/notes.md']],
    web: [
      ['webfetch', 'https://example.com/prices'],
      ['mcp', 'fixture-mcp_search'],
    ],
    commands: [['bash', 'ls -la']],
    outside: [['external_directory', '/etc']],
  }

  it('shows exactly what each ceiling allows without asking', () => {
    for (const row of autonomyCapabilities)
      for (const ceiling of ceilingValues)
        for (const [action, resource] of probes[row.id])
          expect(
            ruleEffect(action, resource, rulesets[ceiling]) === 'allow',
            `${row.id} at ${ceiling}: ${action} ${resource}`
          ).toBe((row.allowed as readonly Ceiling[]).includes(ceiling))
  })

  it('splits the rows a ceiling does alone from those it asks about', () => {
    expect(autonomyAt('ask')).toEqual({ alone: ['read'], asks: ['edit', 'web', 'commands', 'outside'] })
    expect(autonomyAt('auto')).toEqual({ alone: ['read', 'edit', 'web'], asks: ['commands', 'outside'] })
    expect(autonomyAt('full')).toEqual({ alone: ['read', 'edit', 'web', 'commands', 'outside'], asks: [] })
  })
})

describe('bot settings draft', () => {
  it('starts equal to the bot, with nothing to save', () => {
    const scout = bot({ compaction: modelA, compactionSource: 'bot' })
    for (const inheritable of [false, true]) {
      const draft = botSettingsDraft(scout, inheritable)
      expect(changedBotSettings(scout, draft, inheritable)).toEqual([])
      expect(botSettingsPatch(scout, draft, inheritable, [])).toEqual({})
      expect(botSettingsProblems(scout, draft, inheritable)).toEqual([])
    }
  })

  it('ignores surrounding spaces and the order of peers', () => {
    const scout = bot()
    const draft = {
      ...botSettingsDraft(scout, false),
      name: '  Scout ',
      role: 'Finds orders  ',
      instructions: '\nCheck the portal.\n',
      talksTo: ['diary', 'partner'],
    }
    expect(changedBotSettings(scout, draft, false)).toEqual([])
  })

  it('saves only what changed, trimmed, in one request', () => {
    const scout = bot()
    const draft = {
      ...botSettingsDraft(scout, false),
      role: '  Pays invoices ',
      ceiling: 'full' as const,
      selectionId: 'prov::other',
      talksTo: ['partner'],
    }
    expect(changedBotSettings(scout, draft, false)).toEqual(['role', 'ceiling', 'selection', 'talksTo'])
    expect(botSettingsPatch(scout, draft, false, [option('prov', 'other')])).toEqual({
      role: 'Pays invoices',
      ceiling: 'full',
      // A new main model starts without the old one's reasoning and Fast mode.
      selection: { providerId: 'prov', modelId: 'other', reasoning: null, fastMode: false },
      talksTo: ['partner'],
    })
  })

  it('blocks an empty name and names what needs fixing', () => {
    const scout = bot()
    const draft = { ...botSettingsDraft(scout, false), name: '   ' }
    expect(changedBotSettings(scout, draft, false)).toEqual(['name'])
    expect(botSettingsProblems(scout, draft, false)).toEqual(['name'])
  })
})

describe('bot settings draft after the bot changed elsewhere', () => {
  it('follows the bot where the owner has not edited, and keeps their edits', () => {
    const before = bot()
    const previous = botSettingsDraft(before, false)
    const draft = { ...previous, name: 'Scout 2', talksTo: ['diary', 'partner'] }
    const after = bot({ name: 'Renamed', role: 'Pays invoices', ceiling: 'full', talksTo: ['partner'] })
    const next = botSettingsDraft(after, false)
    expect(rebaseBotSettingsDraft(draft, previous, next)).toEqual({
      ...next,
      // Edited: kept, even if the bot changed it too.
      name: 'Scout 2',
      // Reordered only, so not edited: it follows the bot.
      talksTo: ['partner'],
    })
  })
})

describe('bot settings compaction', () => {
  it('shows the environment default as the choice of a bot without a model of its own', () => {
    const inheriting = bot({ compaction: modelA, compactionSource: 'environment' })
    expect(botSettingsDraft(inheriting, true).compaction.modelId).toBe(ENVIRONMENT_COMPACTION_CHOICE)
    expect(botSettingsDraft(inheriting, false).compaction.modelId).toBe('prov::model-a')
    const own = bot({ compaction: modelA, compactionSource: 'bot' })
    expect(botSettingsDraft(own, true).compaction.modelId).toBe('prov::model-a')
  })

  it('sends null to follow the environment default, and a whole config to take a model of its own', () => {
    const own = bot({ compaction: modelA, compactionSource: 'bot' })
    const draft = botSettingsDraft(own, true)
    const inherit = { ...draft, compaction: { ...draft.compaction, modelId: ENVIRONMENT_COMPACTION_CHOICE } }
    expect(botSettingsPatch(own, inherit, true, [])).toEqual({ compaction: null })
    const inheriting = bot({ compaction: modelA, compactionSource: 'environment' })
    const takeOwn = {
      ...botSettingsDraft(inheriting, true),
      compaction: {
        modelId: 'prov::model-b',
        reasoning: null,
        fastMode: false,
        intervalThousands: '90',
        contextLimitThousands: '',
      },
    }
    expect(botSettingsPatch(inheriting, takeOwn, true, [])).toEqual({
      compaction: { providerId: 'prov', modelId: 'model-b', reasoning: null, fastMode: false, intervalTokens: 90_000 },
    })
    // Picking the model it inherits as its own is a change too: it stops following the default.
    const sameAsDefault = {
      ...botSettingsDraft(inheriting, true),
      compaction: {
        modelId: 'prov::model-a',
        reasoning: 'low',
        fastMode: false,
        intervalThousands: '120',
        contextLimitThousands: '',
      },
    }
    expect(changedBotSettings(inheriting, sameAsDefault, true)).toEqual(['compaction'])
  })

  it('saves a context limit with the rest of the compaction config and names an invalid one', () => {
    const own = bot({ compaction: modelA, compactionSource: 'bot' })
    const draft = botSettingsDraft(own, false)
    const limited = { ...draft, compaction: { ...draft.compaction, contextLimitThousands: '300' } }
    expect(changedBotSettings(own, limited, false)).toEqual(['compaction'])
    expect(botSettingsPatch(own, limited, false, [])).toEqual({
      compaction: { ...modelA, contextLimitTokens: 300_000 },
    })
    const tooSmall = { ...draft, compaction: { ...draft.compaction, contextLimitThousands: '50' } }
    expect(botSettingsProblems(own, tooSmall, false)).toEqual(['compactionContextLimit'])
    // A bot that has a limit starts with nothing to save; emptying the field sends the config without it.
    const withLimit = bot({ compaction: { ...modelA, contextLimitTokens: 300_000 }, compactionSource: 'bot' })
    const start = botSettingsDraft(withLimit, false)
    expect(changedBotSettings(withLimit, start, false)).toEqual([])
    const cleared = { ...start, compaction: { ...start.compaction, contextLimitThousands: '' } }
    expect(botSettingsPatch(withLimit, cleared, false, [])).toEqual({ compaction: modelA })
  })

  it('compares configs field by field and blocks an incomplete one', () => {
    const own = bot({ compaction: modelA, compactionSource: 'bot' })
    const form = botSettingsDraft(own, false).compaction
    expect(compactionChange(own, { ...form }, false)).toMatchObject({ dirty: false, valid: true })
    expect(compactionChange(own, { ...form, intervalThousands: '121' }, false)).toMatchObject({ dirty: true })
    const tooOften = { ...botSettingsDraft(own, false), compaction: { ...form, intervalThousands: '5' } }
    expect(botSettingsProblems(own, tooOften, false)).toEqual(['compactionInterval'])
    const setup = bot({ compaction: null, compactionSource: null })
    const untouched = botSettingsDraft(setup, false)
    expect(changedBotSettings(setup, untouched, false)).toEqual([])
    expect(botSettingsProblems(setup, untouched, false)).toEqual([])
  })
})

describe('bot settings translations', () => {
  const lookup = (catalog: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)

  it('names every field, problem, section and autonomy row in both languages', () => {
    const keys = [
      ...['name', 'role', 'instructions', 'ceiling', 'selection', 'compaction', 'talksTo'].map(
        (field) => `botSettings.field.${field}`
      ),
      ...['name', 'role', 'compactionModel', 'compactionInterval', 'compactionContextLimit'].map(
        (problem) => `botSettings.problemField.${problem}`
      ),
      ...[
        'identity',
        'autonomy',
        'model',
        'accounts',
        'skills',
        'peers',
        'routines',
        'memory',
        'environment',
        'where',
        'archive',
      ].map((section) => `botSettings.section.${section}`),
      ...autonomyCapabilities.flatMap((row) => [
        `botSettings.autonomy.row.${row.id}`,
        `botSettings.autonomy.verb.${row.id}`,
      ]),
      ...ceilingValues.map((ceiling) => `botSettings.autonomy.option.${ceiling}`),
    ]
    const missing = keys.flatMap((key) =>
      (['en', 'pt-BR'] as const)
        .filter((language) => typeof lookup(resources[language].fleet, key) !== 'string')
        .map((language) => `${language} ${key}`)
    )
    expect(missing).toEqual([])
  })
})

describe('bot artifact publishing preference', () => {
  it('defaults off and does not send unchanged fields to older gateways', () => {
    const current = bot()
    const draft = botSettingsDraft(current, false)
    expect(draft.publishArtifacts).toBe(false)
    expect(botSettingsPatch(current, draft, false, [])).toEqual({})
  })
  it('patches only the publishing toggle in both directions', () => {
    for (const enabled of [true, false]) {
      const current = bot({ publishArtifacts: !enabled })
      const draft = { ...botSettingsDraft(current, false), publishArtifacts: enabled }
      expect(changedBotSettings(current, draft, false)).toEqual(['publishArtifacts'])
      expect(botSettingsPatch(current, draft, false, [])).toEqual({ publishArtifacts: enabled })
    }
  })
  it('preserves edits when settings arrive from another device', () => {
    const previous = botSettingsDraft(bot(), false)
    const edited = { ...previous, publishArtifacts: true }
    expect(rebaseBotSettingsDraft(edited, previous, { ...previous, name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
      publishArtifacts: true,
    })
  })
  it('names the toggle in both UI catalogs', () => {
    expect(resources.en.ui.artifacts.publishingBot.label).toBe('Publish artifacts')
    expect(resources['pt-BR'].ui.artifacts.publishingBot.label).toBe('Publicar artefatos')
  })
})
