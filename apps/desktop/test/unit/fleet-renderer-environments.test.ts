import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  fleetActivityEntrySchema,
  fleetBotSchema,
  fleetEnvironmentSchema,
  type FleetBot,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import { resources } from '../../src/shared/i18n/resources'
import { groupBotsByEnvironment } from '../../src/renderer/lib/fleet/selectors'
import {
  activitySubject,
  createKeyWatcher,
  creationStepReached,
  creationSteps,
  editEnvironmentName,
  emptyEnvironmentName,
  environmentBots,
  environmentDot,
  environmentNameFor,
  environmentUpdateAvailable,
  filterEnvironmentGroups,
  fleetSearchCount,
  followBotName,
  formatNames,
  hasEnvironments,
  isEnvironmentTarget,
  lifecycleTarget,
  memoryLimitChoices,
  memoryLimitFromValue,
  memoryLimitValue,
  ownerMemoryScope,
  placementRequest,
  provisioningHintKey,
  targetFromParts,
  targetParts,
} from '../../src/renderer/lib/fleet/environments'

const source = (path: string) => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')
const at = '2026-09-26T12:00:00.000Z'
const GB = 1024 ** 3

function bot(id: string, name: string, environmentId: string | null, role = ''): FleetBot {
  return fleetBotSchema.parse({
    id,
    name,
    role,
    instructions: '',
    tint: '#336699',
    ceiling: 'auto',
    selection: null,
    talksTo: [],
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
    environmentId,
    createdAt: at,
    updatedAt: at,
  })
}
function environment(
  id: string,
  name: string,
  botIds: string[],
  patch: Partial<FleetEnvironment> = {}
): FleetEnvironment {
  return fleetEnvironmentSchema.parse({
    id,
    name,
    lifecycle: 'running',
    setup: { step: 'ready', error: null, errorMessage: null },
    resources: { memoryBytes: GB, memoryLimitBytes: 4 * GB, cpuPercent: 3, startedAt: at },
    memoryLimitBytes: null,
    appVersion: '1.0.0',
    capabilities: ['provisioning', 'environments'],
    botIds,
    createdAt: at,
    updatedAt: at,
    ...patch,
  })
}

const acme = environment('acme', 'Acme', ['scout', 'partner'])
const home = environment('home', 'Home', ['diary'])
const bots = [
  bot('scout', 'Scout', 'acme', 'Finds orders'),
  bot('partner', 'Partner', 'acme'),
  bot('diary', 'Diary', 'home'),
  bot('orphan', 'Orphan', 'gone'),
]

describe('environment helpers', () => {
  it('turns the environment UI on only when the gateway advertises environments', () => {
    expect(hasEnvironments({ features: ['provisioning'] })).toBe(false)
    expect(hasEnvironments({ features: ['provisioning', 'environments'] })).toBe(true)
  })

  it('keeps every bot of an environment whose name matches, and only the matching bots of the others', () => {
    const { groups, ungrouped } = groupBotsByEnvironment([home, acme], bots)
    const all = filterEnvironmentGroups(groups, ungrouped, '')
    expect(all.groups.map((group) => [group.environment.name, group.bots.map((item) => item.name)])).toEqual([
      ['Acme', ['Partner', 'Scout']],
      ['Home', ['Diary']],
    ])
    expect(all.ungrouped.map((item) => item.id)).toEqual(['orphan'])
    expect(all.resultCount).toBe(4)

    const byEnvironment = filterEnvironmentGroups(groups, ungrouped, '  ACM ')
    expect(byEnvironment.groups.map((group) => [group.environment.id, group.bots.map((item) => item.id)])).toEqual([
      ['acme', ['partner', 'scout']],
    ])
    expect(byEnvironment.ungrouped).toEqual([])
    expect(byEnvironment.resultCount).toBe(2)

    const byBot = filterEnvironmentGroups(groups, ungrouped, 'orders')
    expect(byBot.groups.map((group) => [group.environment.id, group.bots.map((item) => item.id)])).toEqual([
      ['acme', ['scout']],
    ])
    expect(filterEnvironmentGroups(groups, ungrouped, 'orph').ungrouped.map((item) => item.id)).toEqual(['orphan'])
    expect(filterEnvironmentGroups(groups, ungrouped, 'nothing')).toEqual({ groups: [], ungrouped: [], resultCount: 0 })
  })

  it('counts sidebar search results by environment only when the gateway has environments', () => {
    const snapshot = { bots, environments: [home, acme] }
    expect(fleetSearchCount({ features: ['environments'] }, snapshot, 'acme')).toBe(2)
    expect(fleetSearchCount({ features: [] }, { bots, environments: [] }, 'acme')).toBe(0)
    expect(fleetSearchCount({ features: [] }, { bots, environments: [] }, 'ORDERS')).toBe(1)
  })

  it('counts an empty environment that matches by name as a result', () => {
    const empty = environment('lab', 'Lab', [])
    const { groups, ungrouped } = groupBotsByEnvironment([empty], [])
    expect(filterEnvironmentGroups(groups, ungrouped, 'lab').resultCount).toBe(1)
  })

  it('names a new environment after the bot until the owner edits it', () => {
    let field = followBotName(emptyEnvironmentName, 'Sc')
    field = followBotName(field, 'Scout')
    expect(field).toEqual({ value: 'Scout', edited: false })
    field = editEnvironmentName('Company X')
    expect(followBotName(field, 'Scout 2')).toEqual({ value: 'Company X', edited: true })
    expect(environmentNameFor(field, 'Scout 2')).toBe('Company X')
    // Clearing the field goes back to following the bot's name.
    field = editEnvironmentName('')
    expect(field.edited).toBe(false)
    expect(environmentNameFor(field, ' Scout ')).toBe('Scout')
    expect(followBotName(field, 'Scout')).toEqual({ value: 'Scout', edited: false })
  })

  it('builds the placement of a new bot, and none for gateways without environments', () => {
    expect(placementRequest({ kind: 'new', name: 'Acme' }, false)).toEqual({})
    expect(placementRequest({ kind: 'existing', environmentId: 'acme' }, false)).toEqual({})
    expect(placementRequest({ kind: 'new', name: ' Acme ' }, true)).toEqual({ environment: { name: 'Acme' } })
    expect(placementRequest({ kind: 'existing', environmentId: 'acme' }, true)).toEqual({ environmentId: 'acme' })
    expect(placementRequest({ kind: 'existing', environmentId: null }, true)).toBeNull()
    expect(placementRequest({ kind: 'new', name: '  ' }, true)).toBeNull()
  })

  it('shows the container steps only for a new environment', () => {
    expect(creationSteps(false)).toEqual(['container', 'desktop', 'profile', 'ready'])
    expect(creationSteps(true)).toEqual(['profile', 'ready'])
    const joined = creationSteps(true)
    expect(creationStepReached(joined, 'container', 0)).toBe(false)
    expect(creationStepReached(joined, 'profile', 0)).toBe(true)
    expect(creationStepReached(joined, 'profile', 1)).toBe(false)
    expect(creationStepReached(joined, 'ready', 1)).toBe(true)
    expect(creationStepReached(joined, 'failed', 0)).toBe(false)
    expect(creationStepReached(creationSteps(false), 'desktop', 1)).toBe(true)
  })

  it('offers the server default and whole memory limits, keeping a limit set elsewhere', () => {
    expect(memoryLimitChoices(null).map((choice) => [choice.value, choice.gb])).toEqual([
      ['default', null],
      [String(2 * GB), 2],
      [String(4 * GB), 4],
      [String(8 * GB), 8],
      [String(12 * GB), 12],
      [String(16 * GB), 16],
    ])
    expect(memoryLimitChoices(6 * GB).map((choice) => choice.gb)).toEqual([null, 2, 4, 6, 8, 12, 16])
    expect(memoryLimitChoices(8 * GB)).toHaveLength(6)
    expect(memoryLimitValue(null)).toBe('default')
    expect(memoryLimitFromValue(memoryLimitValue(12 * GB))).toBe(12 * GB)
    expect(memoryLimitFromValue('default')).toBeNull()
  })

  it('names who sees an owner memory entry', () => {
    expect(ownerMemoryScope({ environmentId: null }, [acme])).toEqual({ kind: 'global' })
    expect(ownerMemoryScope({ environmentId: 'acme' }, [acme])).toEqual({
      kind: 'environment',
      id: 'acme',
      name: 'Acme',
    })
    expect(ownerMemoryScope({ environmentId: 'gone' }, [acme])).toEqual({ kind: 'environment', id: 'gone', name: null })
  })

  it('names the bot or the environment of an activity entry', () => {
    const entry = (patch: Record<string, unknown>) =>
      fleetActivityEntrySchema.parse({
        seq: 1,
        at,
        botId: null,
        kind: 'bot_created',
        summary: null,
        data: {},
        ...patch,
      })
    expect(activitySubject(entry({ botId: 'scout', environmentId: 'acme' }), bots, [acme])).toEqual({
      kind: 'bot',
      id: 'scout',
      name: 'Scout',
      tint: '#336699',
    })
    // Configuration is recorded on the environment, with the device name as summary.
    expect(
      activitySubject(entry({ kind: 'bot_configured', environmentId: 'acme', summary: 'Mac' }), bots, [acme])
    ).toEqual({ kind: 'environment', id: 'acme', name: 'Acme' })
    // A deleted environment is only named by its summary.
    expect(
      activitySubject(entry({ kind: 'environment_deleted', environmentId: 'old', summary: 'Old' }), bots, [acme])
    ).toEqual({ kind: 'environment', id: null, name: 'Old' })
    expect(activitySubject(entry({ kind: 'bot_deleted', summary: 'Gone' }), bots, [acme])).toBeNull()
  })

  it('starts, stops and restarts a bot of an environment through its environment', () => {
    expect(lifecycleTarget(bots[0], true)).toEqual({ environmentId: 'acme' })
    expect(lifecycleTarget(bots[0], false)).toEqual({ botId: 'scout' })
    expect(lifecycleTarget(bot('legacy', 'Legacy', null), true)).toEqual({ botId: 'legacy' })
  })

  it('lists the bots of an environment by name for confirmations', () => {
    expect(environmentBots(acme, bots).map((item) => item.name)).toEqual(['Partner', 'Scout'])
    expect(formatNames(['Partner', 'Scout'], 'en')).toBe('Partner and Scout')
    expect(formatNames(['Partner', 'Scout', 'Diary'], 'pt-BR')).toBe('Partner, Scout e Diary')
    expect(formatNames([], 'en')).toBe('')
  })

  it('tells when an environment runs an older image than the server offers', () => {
    expect(environmentUpdateAvailable(acme, { botImageVersion: '1.0.1' })).toBe(true)
    expect(environmentUpdateAvailable(acme, { botImageVersion: '1.0.0' })).toBe(false)
    expect(environmentUpdateAvailable({ appVersion: null }, { botImageVersion: '1.0.1' })).toBe(false)
    expect(environmentUpdateAvailable(acme, null)).toBe(false)
  })

  it('summarizes an environment lifecycle as a status dot', () => {
    expect(environmentDot(acme)).toBe('ready')
    expect(environmentDot(environment('a', 'A', [], { lifecycle: 'restarting' }))).toBe('busy')
    expect(environmentDot(environment('a', 'A', [], { lifecycle: 'stopped' }))).toBe('stopped')
    expect(environmentDot(environment('a', 'A', [], { lifecycle: 'failed' }))).toBe('failed')
    expect(
      environmentDot(
        environment('a', 'A', [], { lifecycle: 'creating', setup: { step: 'failed', error: null, errorMessage: 'x' } })
      )
    ).toBe('failed')
  })

  it('tells environment provisioning targets from bot ones', () => {
    expect(isEnvironmentTarget({ environmentId: 'acme' })).toBe(true)
    expect(isEnvironmentTarget({ botId: 'scout' })).toBe(false)
    expect(isEnvironmentTarget('scout')).toBe(false)
  })

  it('keeps a provisioning target as primitives and sends a bot as a bare id, as before environments', () => {
    expect(targetParts({ environmentId: 'acme' })).toEqual({ scope: 'environment', id: 'acme' })
    expect(targetParts({ botId: 'scout' })).toEqual({ scope: 'bot', id: 'scout' })
    expect(targetParts('scout')).toEqual({ scope: 'bot', id: 'scout' })
    expect(targetFromParts('environment', 'acme')).toEqual({ environmentId: 'acme' })
    expect(targetFromParts('bot', 'scout')).toBe('scout')
  })

  it('explains why accounts, skills and MCP servers cannot be managed yet', () => {
    expect(provisioningHintKey('update-server')).toBe('provisioning.updateServer')
    expect(provisioningHintKey('restart-bot')).toBe('provisioning.restartBot')
    expect(provisioningHintKey('restart-environment')).toBe('provisioning.restartEnvironment')
  })

  it('refreshes on a changed key only, never on mount or on a Strict Mode re-run', () => {
    const changed = createKeyWatcher('a')
    expect(changed('a')).toBe(false)
    expect(changed('a')).toBe(false)
    expect(changed('b')).toBe(true)
    expect(changed('b')).toBe(false)
    expect(changed('a')).toBe(true)
  })
})

describe('environment UI wiring', () => {
  const newComponents = [
    'EnvironmentView',
    'EnvironmentScreen',
    'ScreenFrame',
    'ArchivedEnvironments',
    'ApiKeyAccountForm',
  ]
  const touched = [
    ...newComponents,
    'BotScreen',
    'CreateBotDialog',
    'FleetSidebarPanel',
    'OwnerMemoryView',
    'ServerView',
    'BotSettings',
    'BotView',
  ]

  it('uses the app controls and theme: no native select and no raw colors', () => {
    for (const name of touched) {
      const text = source(`components/fleet/${name}.tsx`)
      expect(text, name).not.toMatch(/<select\b/)
      expect(text, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })

  it('routes the environment view through the main panels and the sidebar', () => {
    const panels = source('lib/use-main-panels.ts')
    expect(panels).toContain("kind: 'environment'")
    expect(panels).toContain('createBotEnvironmentId')
    const app = source('DesktopApp.tsx')
    expect(app).toContain("fleetView?.kind === 'environment'")
    expect(app).toContain('<EnvironmentView')
    expect(app).toContain('initialEnvironmentId={createBotEnvironmentId}')
    const sidebar = source('components/fleet/FleetSidebarPanel.tsx')
    expect(sidebar).toContain('groupBotsByEnvironment(')
    expect(sidebar).toContain('filterEnvironmentGroups(')
    expect(sidebar).toContain('onOpenEnvironment(')
    // Without the feature the flat list of before environments stays.
    expect(sidebar).toContain('hasEnvironments(connection)')
    expect(source('components/Sidebar.tsx')).toContain('onOpenEnvironment={onOpenFleetEnvironment}')
  })

  it('creates a bot in a new or an existing environment with option cards and a searchable picker', () => {
    const dialog = source('components/fleet/CreateBotDialog.tsx')
    expect(dialog).toContain('role="radiogroup"')
    expect(dialog).toContain('<ChoiceMark')
    expect(dialog).toContain('choiceClass(')
    expect(dialog).toContain('<SearchSelect')
    expect(dialog).toContain('placementRequest(')
    expect(dialog).toContain('creationSteps(')
    expect(dialog).toContain('environmentJoinAvailability(')
    expect(dialog).toContain("t('environment.sharedNote')")
    // Bringing accounts from the Mac is for a new environment only.
    expect(dialog).toMatch(/supportsImport && \(!environments \|\| where === 'new'\)/)
  })

  it('shares accounts, skills and MCP servers through the environment and refreshes them on real changes', () => {
    const view = source('components/fleet/EnvironmentView.tsx')
    expect(view).toContain('useFleetProvisioning(')
    expect(view).toContain('environmentProvisioningKey(')
    expect(view).toContain('createKeyWatcher(')
    expect(view).toContain('<BotAccountsSection')
    expect(view).toContain('<BotSkillsMcpSection')
    expect(view).toContain('<ApiKeyAccountForm')
    expect(view).toContain('fleetEnvironmentUiOpen(')
    expect(view).toContain('fleetPatchEnvironment(')
    expect(view).toContain("t('environment.refresh')")
    // No effect keyed on the whole environment object, which changes with every resource sample.
    expect(view).not.toMatch(/\[environment\]\)/)
    expect(view).not.toMatch(/\[[^\]]*environment\.resources[^\]]*\]\)/)
  })

  it('keeps the old bot settings without environments and links to the environment with them', () => {
    const settings = source('components/fleet/BotSettings.tsx')
    expect(settings).toContain('<BotAccountsSection')
    expect(settings).toContain('<BotSkillsMcpSection')
    expect(settings).toContain("t('environment.link'")
    expect(settings).toContain("t('botSettings.where')")
    expect(settings).toContain('<ApiKeyAccountForm')
  })

  it('switches bot screen areas, keeps takeover control, and reports the shared display conflict', () => {
    const screen = source('components/fleet/BotScreen.tsx')
    expect(screen).toContain("const mode = human ? 'control' : 'view'")
    expect(screen).toContain("t('screen.browser')")
    expect(screen).toContain("t('screen.apps')")
    expect(screen).toContain('useFleetScreen(')
    const frame = source('components/fleet/ScreenFrame.tsx')
    expect(frame).toContain('isScreenConflict(')
    expect(frame).toContain('FleetScreenChannel.open(')
    const environmentScreen = source('components/fleet/EnvironmentScreen.tsx')
    expect(environmentScreen).toContain('useFleetScreen(')
    expect(environmentScreen).toContain("t('screen.conflict')")
    // The environment screen shows Maestrly's settings: no bot is held.
    expect(environmentScreen).not.toContain('fleetTakeover')
  })

  it('manages skills, accounts and MCP servers on the environment screen when bots share one', () => {
    const composer = source('components/fleet/BotComposer.tsx')
    expect(composer).toContain('fleetEnvironmentUiOpen(')
    expect(composer).toContain('onOpenEnvironmentScreen')
    expect(composer).toMatch(/\[bot\.id, bot\.ceiling\]\s*\)/)
  })

  it('scopes owner memory to all bots or one environment', () => {
    const view = source('components/fleet/OwnerMemoryView.tsx')
    expect(view).toContain('environmentId: null')
    expect(view).toContain("t('ownerMemory.makeGlobal')")
    expect(view).toContain('ownerMemoryScope(')
    expect(view).toContain('<Select')
  })

  it('lists environments with their bots on the server and archives them apart from bots', () => {
    const server = source('components/fleet/ServerView.tsx')
    expect(server).toContain('<ArchivedEnvironments')
    expect(server).toContain('environmentAction(')
    expect(server).toContain('botsWithDifferentVersion(bots, version)')
    const archived = source('components/fleet/ArchivedEnvironments.tsx')
    expect(archived).toContain('fleetListArchivedEnvironments(')
    expect(archived).toContain('fleetRestoreArchivedEnvironment(')
    expect(archived).toContain('fleetDeleteArchivedEnvironment(')
  })
})

describe('environment translations', () => {
  const en = resources.en.fleet as unknown as Record<string, unknown>
  const pt = resources['pt-BR'].fleet as unknown as Record<string, unknown>
  const lookup = (catalog: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)
  const exists = (catalog: Record<string, unknown>, key: string) =>
    typeof lookup(catalog, key) === 'string' || typeof lookup(catalog, key + '_other') === 'string'

  it('has every literal key the fleet views use, in both languages', () => {
    const files = [
      'components/fleet/EnvironmentView.tsx',
      'components/fleet/EnvironmentScreen.tsx',
      'components/fleet/ScreenFrame.tsx',
      'components/fleet/ArchivedEnvironments.tsx',
      'components/fleet/ApiKeyAccountForm.tsx',
      'components/fleet/BotScreen.tsx',
      'components/fleet/BotSettings.tsx',
      'components/fleet/BotView.tsx',
      'components/fleet/BotComposer.tsx',
      'components/fleet/BotAccountsSection.tsx',
      'components/fleet/BotSkillsMcpSection.tsx',
      'components/fleet/CreateBotDialog.tsx',
      'components/fleet/FleetSidebarPanel.tsx',
      'components/fleet/FleetDigestBanner.tsx',
      'components/fleet/OwnerMemoryView.tsx',
      'components/fleet/ServerView.tsx',
    ]
    const missing: string[] = []
    for (const file of files) {
      for (const match of source(file).matchAll(/\bt\(\s*'([A-Za-z0-9_.-]+)'/g)) {
        const key = match[1]
        if (!exists(en, key)) missing.push(`${file}: en ${key}`)
        if (!exists(pt, key)) missing.push(`${file}: pt-BR ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('uses the approved Portuguese names', () => {
    const values = JSON.stringify(pt)
    for (const text of [
      'Ambiente',
      'Novo ambiente',
      'Ambiente existente',
      'Onde ele roda',
      'Abrir tela do ambiente',
      'Navegador',
      'Apps',
      'Tornar global',
      'Todos os bots',
    ])
      expect(values).toContain(`"${text}"`)
    expect(lookup(pt, 'environment.sharedNote')).toBe(
      'Bots no mesmo ambiente podem ver os arquivos e as telas uns dos outros.'
    )
    expect(lookup(en, 'environment.sharedNote')).toBe(
      "Bots in the same environment can see each other's files and screens."
    )
    expect(lookup(en, 'screen.conflict')).toBe('Another screen in this environment is being controlled.')
  })
})
