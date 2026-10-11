/** What the Artifacts center shows, derived from the list and the bot server's state. No React, so it is tested directly. */
import type { ArtifactListItem, ArtifactServerStatus, LegacyArtifactView } from '../../../shared/artifacts'

/** Who published an artifact, when it was not this computer's own agents: a bot, or another paired computer. */
export function artifactSource(item: ArtifactListItem): 'bot' | 'elsewhere' | 'own' {
  return item.bot ? 'bot' : item.elsewhere ? 'elsewhere' : 'own'
}

export type ArtifactSort = 'updated' | 'created' | 'title' | 'size'
export const ARTIFACT_SORTS: readonly ArtifactSort[] = ['updated', 'created', 'title', 'size']

/** `all`, `standalone`, or `project:<id>`. */
export type ProjectFilter = string
export const ALL_PROJECTS: ProjectFilter = 'all'
export const STANDALONE: ProjectFilter = 'standalone'
export const projectFilter = (id: string): ProjectFilter => `project:${id}`

/** Search and filters only earn their space once there is something to look through. */
export const TOOLBAR_MIN_ARTIFACTS = 4
/** The share of the storage limit from which the center warns before publishing starts to fail. */
export const QUOTA_WARNING_RATIO = 0.9

export interface ProjectOption {
  value: ProjectFilter
  kind: 'all' | 'project' | 'standalone'
  /** The project's name; null for a removed project and for the other kinds. */
  name: string | null
  count: number
}

export function matchesProject(item: ArtifactListItem, filter: ProjectFilter): boolean {
  if (filter === ALL_PROJECTS) return true
  if (filter === STANDALONE) return item.project === null
  return item.project !== null && filter === projectFilter(item.project.id)
}

/** Every project with artifacts, by name, then standalone conversations; the counts include what filters hide. */
export function projectOptions(items: readonly ArtifactListItem[], locale: string): ProjectOption[] {
  const projects = new Map<string, ProjectOption>()
  let standalone = 0
  for (const item of items) {
    if (!item.project) {
      standalone++
      continue
    }
    const value = projectFilter(item.project.id)
    const option = projects.get(value) ?? { value, kind: 'project', name: item.project.name, count: 0 }
    option.count++
    projects.set(value, option)
  }
  const named = [...projects.values()].sort((a, b) => {
    if (a.name === null || b.name === null) return a.name === b.name ? 0 : a.name === null ? 1 : -1
    return a.name.localeCompare(b.name, locale)
  })
  return [
    { value: ALL_PROJECTS, kind: 'all', name: null, count: items.length },
    ...named,
    ...(standalone ? [{ value: STANDALONE, kind: 'standalone' as const, name: null, count: standalone }] : []),
  ]
}

export function visibleArtifacts(
  items: readonly ArtifactListItem[],
  options: { query: string; project: ProjectFilter; sort: ArtifactSort; locale: string }
): ArtifactListItem[] {
  const needle = options.query.trim().toLocaleLowerCase(options.locale)
  const compare: Record<ArtifactSort, (a: ArtifactListItem, b: ArtifactListItem) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    title: (a, b) => a.title.localeCompare(b.title, options.locale),
    size: (a, b) => b.storageBytes - a.storageBytes,
  }
  return items
    .filter(
      (item) =>
        matchesProject(item, options.project) &&
        (!needle || `${item.title}\n${item.description}`.toLocaleLowerCase(options.locale).includes(needle))
    )
    .sort((a, b) => compare[options.sort](a, b) || b.updatedAt - a.updatedAt)
}

export function showToolbar(count: number, query: string, project: ProjectFilter): boolean {
  return count >= TOOLBAR_MIN_ARTIFACTS || query.trim() !== '' || project !== ALL_PROJECTS
}

export function nearQuota(server: ArtifactServerStatus | null): boolean {
  if (server?.state !== 'ready' || !server.quotaBytes) return false
  return server.storageBytes / server.quotaBytes >= QUOTA_WARNING_RATIO
}

/** Why the list cannot be shown: the bot server is missing, too old, out of reach, off, or its host failed. */
export type UnavailableReason = 'absent' | 'unsupported' | 'unreachable' | 'off' | 'problem'

export type CenterBody =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: UnavailableReason }
  | { kind: 'empty' }
  | { kind: 'no-match' }
  | { kind: 'grid' }

/** The bot server's state as a reason the center cannot list artifacts, or null when it can. */
export function serverUnavailableReason(server: ArtifactServerStatus | null): UnavailableReason | null {
  if (!server) return 'unreachable'
  if (server.state === 'ready') return server.problem ? 'problem' : null
  return server.state
}

/**
 * Artifacts live on the bot server, so an empty list only means "no artifacts" while the server is ready and listed
 * them. Otherwise the center explains why it cannot list them, instead of claiming there are none.
 */
export function centerBody(input: {
  loading: boolean
  server: ArtifactServerStatus | null
  listed: boolean
  total: number
  visible: number
}): CenterBody {
  if (input.loading) return { kind: 'loading' }
  const reason = serverUnavailableReason(input.server)
  if (reason) return { kind: 'unavailable', reason }
  if (!input.listed) return { kind: 'unavailable', reason: 'unreachable' }
  if (input.total === 0) return { kind: 'empty' }
  return input.visible === 0 ? { kind: 'no-match' } : { kind: 'grid' }
}

/** What the offer to move this computer's artifacts can do with the bot server as it is. */
export interface MoveDialogModel {
  /** Why moving cannot start now; null when it can. */
  blocked: 'absent' | 'unsupported' | 'unreachable' | null
  /** Hosting on the server is off: moving turns it on first. */
  enableFirst: boolean
  neededBytes: number
  /** Free space on the server, while it is known. */
  freeBytes: number | null
  /** False only when the server is known to lack the space. */
  fits: boolean
  /** Artifacts that become private when they move, because their links change. */
  shared: LegacyArtifactView[]
}

export function moveDialogModel(
  items: readonly LegacyArtifactView[],
  server: ArtifactServerStatus | null
): MoveDialogModel {
  const neededBytes = items.reduce((sum, item) => sum + item.storageBytes, 0)
  const shared = items.filter((item) => item.shared)
  const blocked: MoveDialogModel['blocked'] =
    !server || server.state === 'unreachable' || (server.state === 'ready' && server.problem)
      ? 'unreachable'
      : server.state === 'absent'
        ? 'absent'
        : server.state === 'unsupported' || !server.canMove
          ? 'unsupported'
          : null
  const freeBytes = server?.state === 'ready' && !blocked ? Math.max(0, server.quotaBytes - server.storageBytes) : null
  return {
    blocked,
    enableFirst: server?.state === 'off',
    neededBytes,
    freeBytes,
    fits: freeBytes === null || neededBytes <= freeBytes,
    shared,
  }
}

export type Arrival = 'artifact' | 'version'

/** What changed between two lists: artifacts that appeared, and artifacts that gained a version. */
export function arrivals(
  previous: readonly ArtifactListItem[],
  next: readonly ArtifactListItem[]
): Map<string, Arrival> {
  const before = new Map(previous.map((item) => [item.id, item.currentVersion]))
  const result = new Map<string, Arrival>()
  for (const item of next) {
    const version = before.get(item.id)
    if (version === undefined) result.set(item.id, 'artifact')
    else if (item.currentVersion > version) result.set(item.id, 'version')
  }
  return result
}
