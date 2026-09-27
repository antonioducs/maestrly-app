import { describe, expect, it } from 'vitest'
import {
  fleetBotSchema,
  fleetEnvironmentSchema,
  type FleetBot,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import type { MacImportReport, MacInventory } from '../../src/shared/fleet-provisioning'
import {
  failedImportChoice,
  filterPeerGroups,
  foldText,
  importGroupSize,
  importReportSummary,
  importSections,
  macImportItems,
  mergeImportReport,
  peerGroups,
  sameImportChoice,
  selectedImportItems,
  toggleImportItem,
  withImportGroup,
} from '../../src/renderer/lib/fleet/create-bot'
import { emptyImportChoice, importGroups, recommendedImportChoice } from '../../src/renderer/lib/fleet/provisioning'
import { resources } from '../../src/shared/i18n/resources'

const at = '2026-09-27T12:00:00.000Z'
const inventory: MacInventory = {
  apiKeys: [
    { id: 'k1', name: 'OpenAI (trabalho)', kind: 'openai-responses', host: 'api.openai.com', localOnly: false },
    { id: 'k2', name: 'Ollama', kind: 'openai', host: 'localhost:11434', localOnly: true },
  ],
  copies: [{ id: 'github-copilot:default', kind: 'github-copilot', label: 'GitHub Copilot', expiresAt: null }],
  logins: [
    { id: 'l1', kind: 'codex', label: 'ChatGPT', email: 'voce@exemplo.com' },
    { id: 'l2', kind: 'grok', label: 'Grok', email: null },
  ],
  skills: [
    { name: 'invoice-parser', description: 'Lê faturas em PDF', files: 9, bytes: 1_000, scripts: true, problem: null },
    { name: 'relatório-mensal', description: 'Resumo do mês', files: 2, bytes: 500, scripts: false, problem: null },
    { name: 'video-toolkit', description: 'Corta vídeos', files: 212, bytes: 9e6, scripts: true, problem: 'too-large' },
  ],
  mcpServers: [
    {
      id: 'm1',
      name: 'GitHub',
      transport: 'http',
      target: 'https://api.githubcopilot.com/mcp/',
      warnings: [],
      recommended: true,
    },
    {
      id: 'm2',
      name: 'Figma',
      transport: 'http',
      target: 'http://127.0.0.1:3845/mcp',
      warnings: ['local-url'],
      recommended: false,
    },
  ],
}

describe('what a new bot brings from the Mac', () => {
  const items = macImportItems(inventory)

  it('groups copied accounts apart from sign-ins, blocked skills and MCP servers that depend on the Mac', () => {
    expect(
      importSections(items.accounts, 'accounts').map(({ section, items }) => [section, items.map((item) => item.id)])
    ).toEqual([
      ['copied', ['k1', 'k2', 'github-copilot:default']],
      ['signIn', ['l1', 'l2']],
    ])
    expect(
      importSections(items.skills, 'skills').map(({ section, items }) => [section, items.map((item) => item.id)])
    ).toEqual([
      ['ready', ['invoice-parser', 'relatório-mensal']],
      ['blocked', ['video-toolkit']],
    ])
    expect(
      importSections(items.mcp, 'mcp').map(({ section, items }) => [section, items.map((item) => item.id)])
    ).toEqual([
      ['works', ['m1']],
      ['mayFail', ['m2']],
    ])
    expect(items.accounts.find((item) => item.id === 'k2')?.warnings).toEqual(['localOnly'])
    expect(items.skills.find((item) => item.id === 'video-toolkit')).toMatchObject({
      disabled: true,
      warnings: ['too-large'],
    })
  })

  it('searches names and details without minding case or accents, and can show only what is chosen', () => {
    const names = (query: string, only?: ReturnType<typeof emptyImportChoice>) =>
      importSections(items.skills, 'skills', { query, onlySelected: only }).flatMap(({ items }) =>
        items.map((item) => item.name)
      )
    expect(names('RELATORIO')).toEqual(['relatório-mensal'])
    expect(names('faturas')).toEqual(['invoice-parser'])
    expect(names('nothing here')).toEqual([])
    const chosen = toggleImportItem(emptyImportChoice(), items.skills[1], true)
    expect(names('', chosen)).toEqual(['relatório-mensal'])
    // A host is searched too.
    expect(
      importSections(items.mcp, 'mcp', { query: '127.0.0.1' }).flatMap(({ items }) => items.map((item) => item.id))
    ).toEqual(['m2'])
  })

  it('starts empty, toggles items but never a blocked one, and counts each group', () => {
    let choice = emptyImportChoice()
    choice = toggleImportItem(choice, items.accounts[0], true)
    choice = toggleImportItem(choice, items.accounts[3], true)
    choice = toggleImportItem(choice, items.skills[2], true)
    expect(choice).toMatchObject({ apiKeyIds: ['k1'], loginIds: ['l1'], skillNames: [] })
    expect(importGroups.map((group) => importGroupSize(choice, group))).toEqual([2, 0, 0])
    expect(selectedImportItems(choice, items.accounts).map((item) => item.name)).toEqual([
      'OpenAI (trabalho)',
      'ChatGPT',
    ])
    choice = toggleImportItem(choice, items.accounts[0], false)
    expect(choice.apiKeyIds).toEqual([])
  })

  it('recommends per group exactly what the whole recommendation holds, and clears a group alone', () => {
    let choice = emptyImportChoice()
    for (const group of importGroups) choice = withImportGroup(choice, inventory, group, 'recommended')
    expect(sameImportChoice(choice, recommendedImportChoice(inventory, importGroups))).toBe(true)
    // Local-only keys, blocked skills and MCP servers with warnings are left out.
    expect(choice).toMatchObject({
      apiKeyIds: ['k1'],
      skillNames: ['invoice-parser', 'relatório-mensal'],
      mcpServerIds: ['m1'],
    })
    const cleared = withImportGroup(choice, inventory, 'accounts', 'clear')
    expect(cleared).toMatchObject({ apiKeyIds: [], copyIds: [], loginIds: [], skillNames: choice.skillNames })
    expect(sameImportChoice(cleared, choice)).toBe(false)
  })
})

describe('sending again what did not arrive', () => {
  const choice = {
    apiKeyIds: ['k1'],
    copyIds: ['github-copilot:default'],
    loginIds: ['l1'],
    skillNames: ['invoice-parser', 'relatório-mensal'],
    mcpServerIds: ['m1'],
  }
  const first: MacImportReport = {
    accounts: [
      { id: 'k1', name: 'OpenAI (trabalho)', outcome: 'added', error: null },
      { id: 'github-copilot:default', name: 'GitHub Copilot', outcome: 'failed', error: 'timeout' },
    ],
    skills: [
      { id: 'invoice-parser', name: 'invoice-parser', outcome: 'unchanged', error: null },
      { id: 'relatório-mensal', name: 'relatório-mensal', outcome: 'failed', error: 'timeout' },
    ],
    mcpServers: [{ id: 'm1', name: 'GitHub', outcome: 'updated', error: null }],
  }

  it('sends only the failed items, in their own fields, and never the sign-ins', () => {
    expect(failedImportChoice(first, choice)).toEqual({
      apiKeyIds: [],
      copyIds: ['github-copilot:default'],
      skillNames: ['relatório-mensal'],
      mcpServerIds: [],
      loginIds: [],
    })
  })

  it('merges the new results into the report and counts what arrived', () => {
    const retry: MacImportReport = {
      accounts: [{ id: 'github-copilot:default', name: 'GitHub Copilot', outcome: 'added', error: null }],
      skills: [{ id: 'relatório-mensal', name: 'relatório-mensal', outcome: 'failed', error: 'too big' }],
      mcpServers: [],
    }
    const merged = mergeImportReport(first, retry)
    expect(merged.accounts.map((item) => item.outcome)).toEqual(['added', 'added'])
    expect(merged.skills[1]).toMatchObject({ outcome: 'failed', error: 'too big' })
    const summary = importReportSummary(merged)
    expect(summary.arrived).toEqual({ accounts: 2, skills: 1, mcp: 1 })
    expect(summary.failed.map((item) => [item.group, item.id])).toEqual([['skills', 'relatório-mensal']])
  })
})

describe('bots a bot may talk to', () => {
  const environment = (id: string, name: string, botIds: string[]): FleetEnvironment =>
    fleetEnvironmentSchema.parse({
      id,
      name,
      lifecycle: 'running',
      setup: { step: 'ready', error: null, errorMessage: null },
      resources: { memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, startedAt: null },
      memoryLimitBytes: null,
      appVersion: '1.0.0',
      botIds,
      createdAt: at,
      updatedAt: at,
    })
  const bot = (id: string, name: string, environmentId: string | null, role = ''): FleetBot =>
    fleetBotSchema.parse({
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
  const environments = [
    environment('fin', 'Financeiro', ['f1', 'f2']),
    environment('ops', 'Operações', ['o1']),
    environment('empty', 'Vazio', []),
  ]
  const bots = [
    bot('o1', 'Estoque', 'ops'),
    bot('f2', 'Conciliação', 'fin', 'Fecha o mês'),
    bot('f1', 'Faturas', 'fin'),
    bot('lost', 'Solto', 'gone'),
  ]

  it('groups the others by environment, by name, with bots of no listed environment last', () => {
    const groups = peerGroups(bots, environments, 'f1')
    expect(groups.map((group) => [group.environment?.name ?? null, group.bots.map((item) => item.name)])).toEqual([
      ['Financeiro', ['Conciliação']],
      ['Operações', ['Estoque']],
      [null, ['Solto']],
    ])
    // Without environments, one group without a name.
    expect(peerGroups(bots, undefined).map((group) => [group.environment, group.bots.length])).toEqual([[null, 4]])
  })

  it('finds bots by name or role without minding accents, and keeps every bot of a matching environment', () => {
    const groups = peerGroups(bots, environments)
    const names = (query: string) =>
      filterPeerGroups(groups, query).flatMap((group) => group.bots.map((item) => item.name))
    expect(names('conciliacao')).toEqual(['Conciliação'])
    expect(names('fecha o')).toEqual(['Conciliação'])
    expect(names('OPERA')).toEqual(['Estoque'])
    expect(names('financ')).toEqual(['Conciliação', 'Faturas'])
    expect(names('zzz')).toEqual([])
    expect(names('  ')).toHaveLength(4)
    expect(foldText('Ação')).toBe('acao')
  })
})

describe('create bot translations', () => {
  const lookup = (catalog: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)
  const exists = (catalog: unknown, key: string) =>
    typeof lookup(catalog, key) === 'string' || typeof lookup(catalog, `${key}_other`) === 'string'

  it('names every group, section and count the dialog builds from a variable, in both languages', () => {
    const keys = [
      ...importGroups.flatMap((group) => [
        `create.import.group.${group}`,
        `create.import.none.${group}`,
        `create.import.choose.${group}`,
        `create.progress.counted.${group}`,
        `provisioning.groups.${group}`,
        `provisioning.picker.search.${group}`,
        `provisioning.picker.onlySelected.${group}`,
        `provisioning.picker.recommended.${group}`,
      ]),
      ...['copied', 'signIn', 'ready', 'blocked', 'works', 'mayFail'].flatMap((section) => [
        `provisioning.section.${section}.title`,
        `provisioning.section.${section}.note`,
      ]),
      ...['localOnly', 'local-url', 'mac-path', 'absolute-command', 'unsupported-command', 'unavailable'].map(
        (warning) => `provisioning.warning.${warning}`
      ),
    ]
    const missing = keys.flatMap((key) =>
      (['en', 'pt-BR'] as const)
        .filter((language) => !exists(resources[language].fleet, key))
        .map((language) => `${language} ${key}`)
    )
    expect(missing).toEqual([])
  })
})
