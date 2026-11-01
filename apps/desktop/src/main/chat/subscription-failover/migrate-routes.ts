import {
  SUBSCRIPTION_ACCOUNT_POOL_KINDS,
  accountPoolKindOf,
  activeAccountProviderId,
  type ChatSubscriptionAccountPoolKind,
} from '../../../shared/chat'
import { getAppSetting, getDb, setAppSetting } from '../../store'
import { INSTALLED_BOTS_KEY } from '../../fleet/instance/installed-bots-key'
import { accountPoolAccounts, readSavedAccountPools, saveAccountPool } from './account-pool'
import { clearLegacyFailoverRoutes, readLegacyFailoverRoutes, type LegacyFailoverRoute } from './config'
import { failoverDiag } from './diag'

export interface MigratedFailoverRoute {
  kind: ChatSubscriptionAccountPoolKind
  primaryProviderId: string
}

/** Settings whose model choices accept the active-account selection; each is JSON with `providerId` fields. */
const SELECTION_SETTINGS = [
  'chat.lastSelection',
  'chat.imageInterpreter',
  'chat.backgroundCompaction',
  'chat.subagentProfiles.v1',
] as const

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Replaces every `providerId` found in `renamed`; returns whether anything changed. */
function renameProviderIds(value: unknown, renamed: ReadonlyMap<string, string>): boolean {
  if (Array.isArray(value)) return value.map((item) => renameProviderIds(item, renamed)).some(Boolean)
  if (!isJsonObject(value)) return false
  let changed = false
  for (const [key, child] of Object.entries(value)) {
    if (key === 'providerId' && typeof child === 'string' && renamed.has(child)) {
      value[key] = renamed.get(child)
      changed = true
    } else if (renameProviderIds(child, renamed)) changed = true
  }
  return changed
}

/** Every `providerId` found in a choice. */
function collectProviderIds(value: unknown, into: string[]): void {
  if (Array.isArray(value)) for (const item of value) collectProviderIds(item, into)
  else if (isJsonObject(value))
    for (const [key, child] of Object.entries(value)) {
      if (key === 'providerId' && typeof child === 'string') into.push(child)
      else collectProviderIds(child, into)
    }
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * How many saved choices run on each account: the settings and chats of this computer and, in an environment, its
 * bots, where a bot without a model of its own runs on the default one.
 */
function choiceCounts(defaultProviderId: string | null): Map<string, number> {
  const ids: string[] = []
  for (const key of SELECTION_SETTINGS) collectProviderIds(parseJson(getAppSetting(key)), ids)
  const db = getDb()
  const conversations = db
    .prepare("SELECT ui_prefs FROM conversations WHERE ui_prefs LIKE '%providerId%'")
    .all() as Array<{ ui_prefs: string }>
  for (const row of conversations) {
    const prefs = parseJson(row.ui_prefs)
    if (isJsonObject(prefs)) collectProviderIds(prefs.chat, ids)
  }
  const profiles = db
    .prepare("SELECT value FROM app_settings WHERE key LIKE ? AND key LIKE '%.profile'")
    .all(`${INSTALLED_BOTS_KEY}.%`) as Array<{ value: string }>
  for (const row of profiles) {
    const stored = parseJson(row.value)
    const profile = isJsonObject(stored) && isJsonObject(stored.profile) ? stored.profile : null
    if (!profile) continue
    const selection = isJsonObject(profile.selection) ? profile.selection : null
    const providerId = typeof selection?.providerId === 'string' ? selection.providerId : defaultProviderId
    if (providerId) ids.push(providerId)
  }
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

function renameInSetting(key: string, renamed: ReadonlyMap<string, string>): void {
  const raw = getAppSetting(key)
  if (!raw) return
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return
  }
  if (renameProviderIds(value, renamed)) setAppSetting(key, JSON.stringify(value))
}

function renameInConversations(renamed: ReadonlyMap<string, string>): number {
  const db = getDb()
  const rows = db.prepare("SELECT id, ui_prefs FROM conversations WHERE ui_prefs LIKE '%providerId%'").all() as Array<{
    id: string
    ui_prefs: string
  }>
  const update = db.prepare('UPDATE conversations SET ui_prefs = ? WHERE id = ?')
  let count = 0
  for (const row of rows) {
    let prefs: unknown
    try {
      prefs = JSON.parse(row.ui_prefs)
    } catch {
      continue
    }
    // Only the chat's own choices: its model and its subagent profiles.
    if (!isJsonObject(prefs) || !renameProviderIds(prefs.chat, renamed)) continue
    update.run(JSON.stringify(prefs), row.id)
    count++
  }
  return count
}

/**
 * The route a provider's pool takes over when several accounts had one: the account the most choices run on, then
 * the default model's, then the longest route.
 */
export function routeForKind(
  routes: readonly LegacyFailoverRoute[],
  defaultProviderId: string | null,
  counts: ReadonlyMap<string, number>
): LegacyFailoverRoute | null {
  const rank = (route: LegacyFailoverRoute) => [
    counts.get(route.primaryProviderId) ?? 0,
    route.primaryProviderId === defaultProviderId ? 1 : 0,
    route.fallbackProviderIds.length,
  ]
  let best: LegacyFailoverRoute | null = null
  for (const route of routes) {
    if (!best) {
      best = route
      continue
    }
    const [a, b] = [rank(route), rank(best)]
    const index = a.findIndex((value, i) => value !== b[i])
    if (index >= 0 && a[index]! > b[index]!) best = route
  }
  return best
}

/**
 * Per-account failover routes became each provider's account pool. A provider without a pool of its own takes the
 * route that was on, its primary account preferred so turns start there again once it resets, and the choices
 * made on that account move to the active-account selection: they keep falling back as they did. A bot that chose
 * the account keeps it, fixed: its choice belongs to the bot server, which sends it again. Then the routes are
 * cleared, so this runs once.
 */
export function migrateFailoverRoutesToAccountPools(): MigratedFailoverRoute[] {
  const routes = readLegacyFailoverRoutes()
  const migrated: MigratedFailoverRoute[] = []
  const saved = readSavedAccountPools()
  const defaultProviderId = getAppSetting('chat.defaultProvider')
  const counts = routes.length > 0 ? choiceCounts(defaultProviderId) : new Map<string, number>()
  for (const kind of SUBSCRIPTION_ACCOUNT_POOL_KINDS) {
    if (saved.some((pool) => pool.kind === kind)) continue
    const accounts = accountPoolAccounts(kind)
    const route = routeForKind(
      routes.filter(
        (entry) => accountPoolKindOf(entry.primaryProviderId) === kind && accounts.includes(entry.primaryProviderId)
      ),
      defaultProviderId,
      counts
    )
    if (!route) continue
    const members = [
      route.primaryProviderId,
      ...route.fallbackProviderIds.filter((id) => accounts.includes(id) && accountPoolKindOf(id) === kind),
    ]
    if (members.length < 2) continue
    saveAccountPool({
      kind,
      memberProviderIds: members,
      activeProviderId: route.primaryProviderId,
      policy: 'prefer-active',
      autoJoin: false,
      enabled: true,
    })
    migrated.push({ kind, primaryProviderId: route.primaryProviderId })
  }
  if (migrated.length > 0) {
    const renamed = new Map(migrated.map((entry) => [entry.primaryProviderId, activeAccountProviderId(entry.kind)]))
    const fallbackDefault = defaultProviderId ? renamed.get(defaultProviderId) : undefined
    if (fallbackDefault) setAppSetting('chat.defaultProvider', fallbackDefault)
    for (const key of SELECTION_SETTINGS) renameInSetting(key, renamed)
    const conversations = renameInConversations(renamed)
    failoverDiag('failover-routes-migrated', { migrated, conversations })
  }
  clearLegacyFailoverRoutes()
  return migrated
}
