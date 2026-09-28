import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { MacImportItemResult, MacImportReport, MacInventory } from '../../../shared/fleet-provisioning'
import { recommendedImportChoice, type ImportChoice, type ImportGroup } from './provisioning'
import { groupBotsByEnvironment } from './selectors'

/** Case and accents do not matter to a search. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export type ImportField = keyof ImportChoice
/**
 * Where an item of the Mac shows in the picker: accounts that are copied apart from those signed in again on the
 * server, skills that can be sent apart from those that cannot, MCP servers that work anywhere apart from those that
 * depend on this Mac.
 */
export type ImportSection = 'copied' | 'signIn' | 'ready' | 'blocked' | 'works' | 'mayFail'
export const importSectionOrder: Record<ImportGroup, ImportSection[]> = {
  accounts: ['copied', 'signIn'],
  skills: ['ready', 'blocked'],
  mcp: ['works', 'mayFail'],
}
type Inventory = MacInventory
export type MacImportDetail =
  | { kind: 'api-key'; providerKind: Inventory['apiKeys'][number]['kind']; host: string }
  | { kind: 'copy'; expiresAt: string | null }
  | { kind: 'login'; loginKind: Inventory['logins'][number]['kind']; email: string | null }
  | { kind: 'skill'; description: string; files: number; scripts: boolean }
  | { kind: 'mcp'; transport: Inventory['mcpServers'][number]['transport']; target: string }
export type MacImportItem = {
  group: ImportGroup
  field: ImportField
  id: string
  name: string
  section: ImportSection
  detail: MacImportDetail
  /** Translation keys under `provisioning.warning`. */
  warnings: string[]
  disabled: boolean
}

/** What this Mac can send, by group, in the order the inventory lists it. */
export function macImportItems(inventory: MacInventory): Record<ImportGroup, MacImportItem[]> {
  return {
    accounts: [
      ...inventory.apiKeys.map(
        (item): MacImportItem => ({
          group: 'accounts',
          field: 'apiKeyIds',
          id: item.id,
          name: item.name,
          section: 'copied',
          detail: { kind: 'api-key', providerKind: item.kind, host: item.host },
          warnings: item.localOnly ? ['localOnly'] : [],
          disabled: false,
        })
      ),
      ...inventory.copies.map(
        (item): MacImportItem => ({
          group: 'accounts',
          field: 'copyIds',
          id: item.id,
          name: item.label,
          section: 'copied',
          detail: { kind: 'copy', expiresAt: item.expiresAt },
          warnings: [],
          disabled: false,
        })
      ),
      ...inventory.logins.map(
        (item): MacImportItem => ({
          group: 'accounts',
          field: 'loginIds',
          id: item.id,
          name: item.label,
          section: 'signIn',
          detail: { kind: 'login', loginKind: item.kind, email: item.email },
          warnings: [],
          disabled: false,
        })
      ),
    ],
    skills: inventory.skills.map(
      (item): MacImportItem => ({
        group: 'skills',
        field: 'skillNames',
        id: item.name,
        name: item.name,
        section: item.problem ? 'blocked' : 'ready',
        detail: { kind: 'skill', description: item.description, files: item.files, scripts: item.scripts },
        warnings: item.problem ? [item.problem] : [],
        disabled: !!item.problem,
      })
    ),
    mcp: inventory.mcpServers.map(
      (item): MacImportItem => ({
        group: 'mcp',
        field: 'mcpServerIds',
        id: item.id,
        name: item.name,
        section: item.warnings.length ? 'mayFail' : 'works',
        detail: { kind: 'mcp', transport: item.transport, target: item.target },
        warnings: [...item.warnings],
        disabled: false,
      })
    ),
  }
}

export function importItemSelected(choice: ImportChoice, item: Pick<MacImportItem, 'field' | 'id'>): boolean {
  return choice[item.field].includes(item.id)
}
export function toggleImportItem(
  choice: ImportChoice,
  item: Pick<MacImportItem, 'field' | 'id' | 'disabled'>,
  selected: boolean
): ImportChoice {
  const rest = choice[item.field].filter((id) => id !== item.id)
  return { ...choice, [item.field]: selected && !item.disabled ? [...rest, item.id] : rest }
}
/** The selected items of a group, in the order the Mac lists them. */
export function selectedImportItems(choice: ImportChoice, items: MacImportItem[]): MacImportItem[] {
  return items.filter((item) => importItemSelected(choice, item))
}
const groupFields: Record<ImportGroup, ImportField[]> = {
  accounts: ['apiKeyIds', 'copyIds', 'loginIds'],
  skills: ['skillNames'],
  mcp: ['mcpServerIds'],
}
export function importGroupSize(choice: ImportChoice, group: ImportGroup): number {
  return groupFields[group].reduce((sum, field) => sum + choice[field].length, 0)
}
/** The choice with one group replaced by what the app recommends for it, or cleared. */
export function withImportGroup(
  choice: ImportChoice,
  inventory: MacInventory,
  group: ImportGroup,
  mode: 'recommended' | 'clear'
): ImportChoice {
  const recommended = recommendedImportChoice(inventory, [group])
  const next = { ...choice }
  for (const field of groupFields[group]) next[field] = mode === 'recommended' ? recommended[field] : []
  return next
}
export function sameImportChoice(a: ImportChoice, b: ImportChoice): boolean {
  return (Object.keys(a) as ImportField[]).every(
    (field) => a[field].length === b[field].length && a[field].every((id) => b[field].includes(id))
  )
}
/** The items of a group a search shows, by section; a section with none left is dropped. */
export function importSections(
  items: MacImportItem[],
  group: ImportGroup,
  filter: { query?: string; onlySelected?: ImportChoice } = {}
): Array<{ section: ImportSection; items: MacImportItem[] }> {
  const query = foldText(filter.query?.trim() ?? '')
  const shown = items.filter(
    (item) =>
      item.group === group &&
      (!query || foldText(`${item.name} ${importDetailText(item.detail)}`).includes(query)) &&
      (!filter.onlySelected || importItemSelected(filter.onlySelected, item))
  )
  return importSectionOrder[group]
    .map((section) => ({ section, items: shown.filter((item) => item.section === section) }))
    .filter((entry) => entry.items.length)
}
/** The plain text of a detail a search looks in (host, description, command), never its translated wording. */
function importDetailText(detail: MacImportDetail): string {
  switch (detail.kind) {
    case 'api-key':
      return detail.host
    case 'login':
      return detail.email ?? ''
    case 'skill':
      return detail.description
    case 'mcp':
      return detail.target
    case 'copy':
      return ''
  }
}

/**
 * What to send again after an import: the items that failed, in their fields. Sign-ins are never part of an import;
 * they are done apart.
 */
export function failedImportChoice(report: MacImportReport, choice: ImportChoice): ImportChoice {
  const failed = (items: MacImportItemResult[]) =>
    items.filter((item) => item.outcome === 'failed').map((item) => item.id)
  const accounts = failed(report.accounts)
  return {
    apiKeyIds: choice.apiKeyIds.filter((id) => accounts.includes(id)),
    copyIds: choice.copyIds.filter((id) => accounts.includes(id)),
    skillNames: choice.skillNames.filter((id) => failed(report.skills).includes(id)),
    mcpServerIds: choice.mcpServerIds.filter((id) => failed(report.mcpServers).includes(id)),
    loginIds: [],
  }
}
/** A report with the items sent again replaced by their new result. */
export function mergeImportReport(previous: MacImportReport, retry: MacImportReport): MacImportReport {
  const merge = (before: MacImportItemResult[], after: MacImportItemResult[]) =>
    before.map((item) => after.find((result) => result.id === item.id) ?? item)
  return {
    accounts: merge(previous.accounts, retry.accounts),
    skills: merge(previous.skills, retry.skills),
    mcpServers: merge(previous.mcpServers, retry.mcpServers),
  }
}
export const reportGroups = [
  ['accounts', 'accounts'],
  ['skills', 'skills'],
  ['mcp', 'mcpServers'],
] as const satisfies ReadonlyArray<readonly [ImportGroup, keyof MacImportReport]>
/** How many items of each group arrived, and those that did not. */
export function importReportSummary(report: MacImportReport): {
  arrived: Record<ImportGroup, number>
  failed: Array<MacImportItemResult & { group: ImportGroup }>
} {
  const arrived = { accounts: 0, skills: 0, mcp: 0 }
  const failed: Array<MacImportItemResult & { group: ImportGroup }> = []
  for (const [group, key] of reportGroups)
    for (const item of report[key]) {
      if (item.outcome === 'failed') failed.push({ ...item, group })
      else arrived[group]++
    }
  return { arrived, failed }
}

export type PeerGroup = { environment: FleetEnvironment | null; bots: FleetBot[] }
/**
 * The bots a new or existing bot may talk to, by environment (by name), the bots of no listed environment last. A
 * gateway without environments gives one group without a name.
 */
export function peerGroups(
  bots: FleetBot[],
  environments: FleetEnvironment[] | undefined,
  selfId?: string
): PeerGroup[] {
  const others = bots.filter((bot) => bot.id !== selfId)
  const { groups, ungrouped } = groupBotsByEnvironment(environments ?? [], others)
  return [
    ...groups.filter((group) => group.bots.length),
    ...(ungrouped.length ? [{ environment: null, bots: ungrouped }] : []),
  ]
}
/** A search by bot name or role; an environment whose name matches keeps all its bots. */
export function filterPeerGroups(groups: PeerGroup[], query: string): PeerGroup[] {
  const q = foldText(query.trim())
  if (!q) return groups
  return groups.flatMap((group) => {
    if (group.environment && foldText(group.environment.name).includes(q)) return [group]
    const bots = group.bots.filter((bot) => foldText(`${bot.name} ${bot.role}`).includes(q))
    return bots.length ? [{ ...group, bots }] : []
  })
}
