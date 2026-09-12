import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  CwdActivityItem,
  LocalBranchIntent,
  LocalChangeSummary,
  LocalConversationBlocker,
  LocalConversationPreview,
  LocalConversationRecovery,
  LocalConversationStrategy,
} from '../../shared/local-conversation'
import { hasConflictMarkers, hasUnmergedFiles, listWorktrees } from '../git-service'
import { GitCommandError, runGit, runGitOrNull, runGitRaw } from '../git-command'

interface StatusSnapshot {
  raw: string
  changes: LocalChangeSummary
  unmerged: string[]
  submoduleDirty: string[]
  trackedPaths: string[]
  trackedStats: string[]
  untrackedStats: string[]
  stagedIndex: string
  markers: boolean
  markerPaths: string[]
  headMarkerPaths: string[]
  targetMarkerPaths?: string[]
}

interface ResolvedTarget {
  branch: string
  oid: string
  label: string
  switchArgs: string[] | null
  postSwitchArgs: string[][]
  createsBranch: boolean
}

export interface PreparedLocalGitOperation {
  cwd: string
  intent: LocalBranchIntent
  currentBranch: string
  headOid: string
  target: ResolvedTarget
  strategy: LocalConversationStrategy
  status: StatusSnapshot
  ignoredCollisions: string[]
  blockers: LocalConversationBlocker[]
  activity: CwdActivityItem[]
  fingerprint: string
  preview: LocalConversationPreview
}

/** Single attach-only predicate shared by preparation and the public wrapper; do not duplicate it. */
function isAttachOnlyTarget(intent: LocalBranchIntent, target: ResolvedTarget, currentBranch: string): boolean {
  return (
    intent.type === 'switch-existing' &&
    target.switchArgs === null &&
    !target.createsBranch &&
    target.branch === currentBranch
  )
}

/** Selecting the currently checked-out branch only attaches a conversation without Git mutation. */
export function isLocalConversationAttachOnly(operation: PreparedLocalGitOperation): boolean {
  return isAttachOnlyTarget(operation.intent, operation.target, operation.currentBranch)
}

/** Cheap confirmation recheck: attach-only requires checkout to remain on the target branch. */
export async function isAttachTargetCurrentBranch(operation: PreparedLocalGitOperation): Promise<boolean> {
  return (await runGitOrNull(operation.cwd, ['branch', '--show-current'])) === operation.target.branch
}

export type LocalGitExecutionResult =
  | { status: 'applied'; stashOid?: string; marker?: string }
  | { status: 'stale'; current: PreparedLocalGitOperation }
  | { status: 'blocked'; current: PreparedLocalGitOperation }
  | { status: 'recovery-required'; recovery: LocalConversationRecovery; stashOid?: string; marker?: string }

/** Serializable plan to transfer dirty local changes into a new worktree. */
export interface PreparedWorktreeTransfer {
  source: PreparedLocalGitOperation
  destination: string
  preservationFingerprint: string
  ignoredPaths: string[]
  /**
   * Created during preparation so the operation's stash OID can be found after a crash following stash
   * push.
   */
  stashMarker: string
  /** Deterministic operation directory for recovery after interrupted rollback. */
  rollbackQuarantine: string
}

export type WorktreeTransferExecutionResult =
  | { status: 'applied'; stashOid?: string; marker?: string }
  | { status: 'stale'; current: PreparedWorktreeTransfer }
  | { status: 'blocked'; current: PreparedWorktreeTransfer }
  | { status: 'recovery-required'; recovery: LocalConversationRecovery; stashOid?: string; marker?: string }

export interface IgnoredTransferCandidate {
  path: string
  size: number
  kind: 'file' | 'directory' | 'symlink' | 'other'
  trackedCollision: boolean
}

function splitNul(raw: string): string[] {
  const parts = raw.split('\0')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

function statusPath(record: string): string {
  const type = record[0]
  if (type === '?' || type === '!') return record.slice(2)
  if (type === '1') return record.split(' ').slice(8).join(' ')
  if (type === '2') return record.split(' ').slice(9).join(' ')
  if (type === 'u') return record.split(' ').slice(10).join(' ')
  return ''
}

/** Parse porcelain-v2 NUL-delimited paths, skipping the extra original-path record for renames/copies. */
function statusPaths(raw: string): string[] {
  const records = splitNul(raw)
  const out: string[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record[0] === '2') index += 1 // the next record is the original rename/copy path
    const relative = statusPath(record)
    if (relative) out.push(relative)
  }
  return out
}

async function statFingerprint(cwd: string, paths: string[]): Promise<string[]> {
  return Promise.all(
    [...new Set(paths)].sort().map(async (relative) => {
      try {
        const stat = await fs.lstat(path.join(cwd, relative))
        return `${relative}\0${stat.size}\0${stat.mtimeMs}\0${stat.isDirectory() ? 'd' : 'f'}`
      } catch {
        return `${relative}\0missing`
      }
    })
  )
}

async function workingTreeFingerprint(cwd: string, paths: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const relative of [...new Set(paths)].sort()) {
    const absolute = path.join(cwd, relative)
    hash.update(relative).update('\0')
    try {
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink()) {
        hash
          .update('l\0')
          .update(await fs.readlink(absolute))
          .update('\0')
      } else if (stat.isFile()) {
        hash.update(`f\0${stat.mode & 0o7777}\0`)
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(absolute)
          stream.on('data', (chunk) => hash.update(chunk))
          stream.on('error', reject)
          // Closing the file handle is part of completion before any worktree rename.
          stream.on('close', resolve)
        })
        hash.update('\0')
      } else {
        hash.update(stat.isDirectory() ? 'd\0' : 'o\0')
      }
    } catch {
      hash.update('missing\0')
    }
  }
  return hash.digest('hex')
}

async function readStatus(cwd: string): Promise<StatusSnapshot> {
  const raw = await runGitRaw(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
  const records = splitNul(raw)
  const changes: LocalChangeSummary = { staged: [], unstaged: [], untracked: [] }
  const unmerged: string[] = []
  const submoduleDirty: string[] = []
  const trackedChanged: string[] = []
  const indexVerificationPaths: string[] = []

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const type = record[0]
    if (type === '?') {
      changes.untracked.push(statusPath(record))
      continue
    }
    const originalPath = type === '2' ? records[index + 1] : undefined
    if (type === '2') index += 1 // the next record is the original rename/copy path
    const fields = record.split(' ')
    const xy = fields[1] ?? '..'
    const sub = fields[2] ?? 'N...'
    const relative = statusPath(record)
    if (type === 'u') {
      unmerged.push(relative)
      continue
    }
    if (xy[0] && xy[0] !== '.') {
      changes.staged.push(relative)
      indexVerificationPaths.push(relative)
      if (originalPath) indexVerificationPaths.push(originalPath)
    }
    if (xy[1] && xy[1] !== '.') changes.unstaged.push(relative)
    if ((xy[0] && xy[0] !== '.') || (xy[1] && xy[1] !== '.')) {
      trackedChanged.push(relative)
      if (originalPath) trackedChanged.push(originalPath)
    }
    if (sub.startsWith('S') && (sub[1] !== '.' || sub[2] !== '.' || sub[3] !== '.')) {
      submoduleDirty.push(relative)
    }
  }

  const stagedPaths = [...new Set(indexVerificationPaths)].sort()
  const stagedEntries =
    stagedPaths.length > 0 ? await runGitRaw(cwd, ['ls-files', '-s', '-z', '--', ...stagedPaths]) : ''
  const stagedIndex = `${JSON.stringify(stagedPaths)}\0${stagedEntries}`
  const trackedPaths = [...new Set(trackedChanged)].sort()
  const markers = await hasConflictMarkers(cwd)
  return {
    raw,
    changes,
    unmerged,
    submoduleDirty,
    trackedPaths,
    trackedStats: await statFingerprint(cwd, trackedPaths),
    untrackedStats: await statFingerprint(cwd, changes.untracked),
    stagedIndex,
    markers,
    markerPaths: markers ? await conflictMarkerPaths(cwd) : [],
    // Only inspect committed markers to subtract from local marker paths; without local markers a full HEAD
    // grep adds no value.
    headMarkerPaths: markers ? await conflictMarkerPaths(cwd, 'HEAD') : [],
  }
}

async function validateBranch(cwd: string, branch: string): Promise<boolean> {
  return (await runGitOrNull(cwd, ['check-ref-format', '--branch', branch])) !== null
}

async function exactOid(cwd: string, ref: string): Promise<string | null> {
  return runGitOrNull(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
}

async function resolveTarget(
  cwd: string,
  intent: LocalBranchIntent,
  currentBranch: string,
  headOid: string
): Promise<{ target?: ResolvedTarget; blockers: LocalConversationBlocker[] }> {
  const blockers: LocalConversationBlocker[] = []
  if (!(await validateBranch(cwd, intent.branch))) {
    return { blockers: [{ code: 'branch-invalid', message: `Invalid branch: ${intent.branch}` }] }
  }

  const localRef = `refs/heads/${intent.branch}`
  const localOid = await exactOid(cwd, localRef)
  if (intent.type !== 'switch-existing' && localOid) {
    return { blockers: [{ code: 'branch-exists', message: `Branch ${intent.branch} already exists.` }] }
  }

  if (intent.type === 'create-from-head') {
    return {
      target: {
        branch: intent.branch,
        oid: headOid,
        label: 'Current HEAD',
        switchArgs: ['switch', '-c', intent.branch],
        postSwitchArgs: [],
        createsBranch: true,
      },
      blockers,
    }
  }

  const ref = intent.ref
  let refName: string
  if (ref.kind === 'local') {
    if (!(await validateBranch(cwd, ref.name))) {
      return { blockers: [{ code: 'branch-invalid', message: `Invalid local ref: ${ref.name}` }] }
    }
    refName = `refs/heads/${ref.name}`
  } else {
    const expected = `refs/remotes/${ref.remote}/${ref.name}`
    if (ref.ref !== expected || !(await validateBranch(cwd, ref.name))) {
      return { blockers: [{ code: 'branch-invalid', message: `Invalid remote ref: ${ref.ref}` }] }
    }
    // Check exact refs per configured remote. Suffix matching could confuse origin/feature/name with name
    // and falsely report ambiguity.
    const remotes = (await runGitRaw(cwd, ['remote'])).split('\n').filter(Boolean)
    const remoteMatches: string[] = []
    for (const remote of remotes) {
      const candidate = `refs/remotes/${remote}/${ref.name}`
      if ((await runGitOrNull(cwd, ['show-ref', '--verify', candidate])) !== null) {
        remoteMatches.push(candidate)
      }
    }
    if (remoteMatches.length > 1) {
      return {
        blockers: [
          {
            code: 'remote-ambiguous',
            message: `A branch remota ${ref.name} exists in more than one remote.`,
            paths: remoteMatches,
          },
        ],
      }
    }
    refName = expected
  }
  const oid = await exactOid(cwd, refName)
  if (!oid) {
    return { blockers: [{ code: 'ref-not-found', message: `Ref ${refName} does not exist locally.` }] }
  }

  if (intent.type === 'create-from-ref') {
    return {
      target: {
        branch: intent.branch,
        oid,
        label: refName,
        switchArgs: ['switch', '--no-overwrite-ignore', '--no-track', '-c', intent.branch, oid],
        postSwitchArgs: [],
        createsBranch: true,
      },
      blockers,
    }
  }

  if (ref.kind === 'local') {
    if (!localOid || ref.name !== intent.branch) {
      return { blockers: [{ code: 'ref-not-found', message: `Local branch ${intent.branch} does not exist.` }] }
    }
    return {
      target: {
        branch: intent.branch,
        oid,
        label: refName,
        switchArgs:
          intent.branch === currentBranch ? null : ['switch', '--no-overwrite-ignore', '--no-guess', intent.branch],
        postSwitchArgs: [],
        createsBranch: false,
      },
      blockers,
    }
  }

  if (localOid) {
    // A same-named local branch that is current makes remote selection attach-only too. Ambiguity exists
    // only when the local branch is not current.
    if (intent.branch === currentBranch) {
      return {
        target: {
          branch: intent.branch,
          oid: localOid,
          label: localRef,
          switchArgs: null,
          postSwitchArgs: [],
          createsBranch: false,
        },
        blockers,
      }
    }
    return { blockers: [{ code: 'branch-exists', message: `Local branch ${intent.branch} already exists.` }] }
  }
  return {
    target: {
      branch: intent.branch,
      oid,
      label: refName,
      switchArgs: ['switch', '--no-overwrite-ignore', '--no-track', '-c', intent.branch, oid],
      postSwitchArgs: [['branch', '--set-upstream-to', `${ref.remote}/${ref.name}`, intent.branch]],
      createsBranch: true,
    },
    blockers,
  }
}

async function gitPathExists(cwd: string, name: string): Promise<boolean> {
  const value = await runGitOrNull(cwd, ['rev-parse', '--git-path', name])
  if (!value) return false
  try {
    await fs.access(path.isAbsolute(value) ? value : path.join(cwd, value))
    return true
  } catch {
    return false
  }
}

async function operationBlockers(cwd: string, status: StatusSnapshot): Promise<LocalConversationBlocker[]> {
  const blockers: LocalConversationBlocker[] = []
  const operations: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['sequencer', 'sequencer'],
    ['BISECT_START', 'bisect'],
  ]
  const active: string[] = []
  for (const [gitPath, label] of operations) if (await gitPathExists(cwd, gitPath)) active.push(label)
  if (active.length > 0) {
    blockers.push({ code: 'git-operation', message: `Git operation in progress: ${[...new Set(active)].join(', ')}.` })
  }
  if (status.unmerged.length > 0 || (await hasUnmergedFiles(cwd))) {
    blockers.push({ code: 'unmerged', message: 'There are conflicting files.', paths: status.unmerged })
  }
  if (status.submoduleDirty.length > 0) {
    blockers.push({
      code: 'submodule-dirty',
      message: 'A submodule has internal changes.',
      paths: status.submoduleDirty,
    })
  }
  return blockers
}

function pathAncestors(relative: string): string[] {
  const out: string[] = []
  let index = relative.indexOf('/')
  while (index !== -1) {
    out.push(relative.slice(0, index))
    index = relative.indexOf('/', index + 1)
  }
  return out
}

export async function listIgnoredTransferCandidates(
  cwd: string,
  targetOid: string
): Promise<IgnoredTransferCandidate[]> {
  const [ignoredRaw, trackedRaw] = await Promise.all([
    runGitRaw(cwd, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory',
      '-z',
    ]),
    runGitRaw(cwd, ['ls-tree', '-r', '--name-only', '-z', targetOid]),
  ])
  const tracked = splitNul(trackedRaw)
  const trackedSet = new Set(tracked)
  const candidates: IgnoredTransferCandidate[] = []
  for (const raw of splitNul(ignoredRaw)) {
    const relative = raw.replace(/\/$/, '')
    if (!relative) continue
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(path.join(cwd, relative))
    } catch {
      continue
    }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
    const prefix = `${relative}/`
    const trackedCollision =
      trackedSet.has(relative) ||
      pathAncestors(relative).some((ancestor) => trackedSet.has(ancestor)) ||
      (kind === 'directory' && tracked.some((trackedPath) => trackedPath.startsWith(prefix)))
    candidates.push({ path: relative, size: stat.size, kind, trackedCollision })
  }
  return candidates.sort((a, b) => a.path.localeCompare(b.path))
}

async function ignoredCollisions(cwd: string, targetOid: string): Promise<string[]> {
  const [ignoredRaw, trackedRaw] = await Promise.all([
    runGitRaw(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
    runGitRaw(cwd, ['ls-tree', '-r', '-z', '--name-only', targetOid]),
  ])
  // Use sets rather than Cartesian comparisons because ignored-file inventory may include tens of thousands
  // of node_modules files on every prepare/confirm.
  const tracked = new Set(splitNul(trackedRaw))
  const trackedDirs = new Set<string>()
  for (const trackedPath of tracked) {
    for (const dir of pathAncestors(trackedPath)) trackedDirs.add(dir)
  }
  const collisions = new Set<string>()
  for (const ignoredPath of splitNul(ignoredRaw)) {
    // Detect exact collisions or ignored files beneath a path tracked as a file at the destination.
    if (tracked.has(ignoredPath) || pathAncestors(ignoredPath).some((dir) => tracked.has(dir))) {
      collisions.add(ignoredPath)
      continue
    }
    // Check type on demand only when an ignored path occupies a destination directory.
    if (!trackedDirs.has(ignoredPath)) continue
    let ignoredIsDirectory = false
    try {
      ignoredIsDirectory = (await fs.lstat(path.join(cwd, ignoredPath))).isDirectory()
    } catch {
      // Disappearing paths are handled as stale by fingerprint/revalidation.
    }
    if (!ignoredIsDirectory) collisions.add(ignoredPath)
  }
  return [...collisions].sort()
}

async function conflictMarkerPaths(cwd: string, ref?: string): Promise<string[]> {
  const args = ['grep', '-lzIE', '^(<{7}|>{7})( |$)']
  if (ref) args.push(ref)
  args.push('--')
  const raw = await runGitOrNull(cwd, args)
  const prefix = ref ? `${ref}:` : ''
  return raw
    ? splitNul(raw)
        .map((entry) => (prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
        .sort()
    : []
}

function operationFingerprint(
  headOid: string,
  targetOid: string,
  currentBranch: string,
  status: StatusSnapshot
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        headOid,
        targetOid,
        currentBranch,
        status: status.raw,
        stagedIndex: status.stagedIndex,
        trackedStats: status.trackedStats,
        untrackedStats: status.untrackedStats,
      })
    )
    .digest('hex')
}

function activityBlockers(activity: CwdActivityItem[]): LocalConversationBlocker[] {
  const blocking = activity.filter((item) => item.blocking)
  return blocking.length === 0
    ? []
    : [
        {
          code: 'activity',
          message: `There is active execution in this directory: ${blocking.map((item) => `${item.kind} (${item.count})`).join(', ')}.`,
        },
      ]
}

export async function prepareLocalGitOperation(
  cwd: string,
  intent: LocalBranchIntent,
  activity: CwdActivityItem[] = []
): Promise<PreparedLocalGitOperation> {
  const [currentBranch, headOid, status] = await Promise.all([
    runGit(cwd, ['branch', '--show-current']),
    runGit(cwd, ['rev-parse', '--verify', 'HEAD']),
    readStatus(cwd),
  ])
  const resolved = await resolveTarget(cwd, intent, currentBranch, headOid)
  const fallbackTarget: ResolvedTarget = {
    branch: intent.branch,
    oid: headOid,
    label: intent.branch,
    switchArgs: null,
    postSwitchArgs: [],
    createsBranch: false,
  }
  const target = resolved.target ?? fallbackTarget
  const dirty = status.raw.length > 0
  const strategy: LocalConversationStrategy =
    intent.type === 'create-from-head'
      ? 'switch-head'
      : dirty && target.oid !== headOid
        ? 'stash-switch-apply'
        : 'switch-direct'
  const attachOnly = isAttachOnlyTarget(intent, target, currentBranch)

  const blockers = [
    ...resolved.blockers,
    ...(attachOnly ? [] : await operationBlockers(cwd, status)),
    ...(attachOnly ? [] : activityBlockers(activity)),
  ]
  if (!attachOnly) {
    const worktrees = await listWorktrees(cwd)
    const branchWorktree = worktrees.find(
      (item) => item.branch === target.branch && path.resolve(item.path) !== path.resolve(cwd)
    )
    if (branchWorktree) {
      blockers.push({
        code: 'branch-in-worktree',
        message: `Branch ${target.branch} is already open in another worktree.`,
        paths: [branchWorktree.path],
      })
    }
  }
  const collisions = !attachOnly && resolved.target ? await ignoredCollisions(cwd, target.oid) : []
  if (collisions.length > 0) {
    blockers.push({
      code: 'ignored-collision',
      message: 'Ignored files collide with tracked destination paths.',
      paths: collisions,
    })
  }
  // Destination marker baseline matters only as a post-apply allowlist for stash-based transfer.
  status.targetMarkerPaths =
    !attachOnly && resolved.target && strategy === 'stash-switch-apply'
      ? await conflictMarkerPaths(cwd, target.oid)
      : []
  const locallyIntroducedMarkers = status.markerPaths.filter(
    (markerPath) => !status.headMarkerPaths.includes(markerPath)
  )
  if (!attachOnly && locallyIntroducedMarkers.length > 0) {
    blockers.push({
      code: 'unmerged',
      message: 'Local changes introduce conflict markers.',
      paths: locallyIntroducedMarkers,
    })
  }
  const fingerprint = operationFingerprint(headOid, target.oid, currentBranch, status)
  const preview: LocalConversationPreview = {
    currentBranch,
    headOid,
    targetBranch: target.branch,
    targetOid: target.oid,
    targetLabel: target.label,
    strategy,
    changes: status.changes,
    ignoredCollisions: collisions,
    blockers,
    activity,
    dirty,
    requiresConfirmation: dirty && (currentBranch !== target.branch || headOid !== target.oid),
  }
  return {
    cwd,
    intent,
    currentBranch,
    headOid,
    target,
    strategy,
    status,
    ignoredCollisions: collisions,
    blockers,
    activity,
    fingerprint,
    preview,
  }
}

async function recoveryState(
  operation: PreparedLocalGitOperation,
  message: string,
  stashOid?: string,
  marker?: string,
  options: { offerOriginalRestore?: boolean } = {}
): Promise<LocalConversationRecovery> {
  const currentBranch = (await runGitOrNull(operation.cwd, ['branch', '--show-current'])) ?? ''
  const headOid = (await runGitOrNull(operation.cwd, ['rev-parse', '--verify', 'HEAD'])) ?? ''
  const statusRaw = await runGitRaw(operation.cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']).catch(
    () => ''
  )
  const status = statusPaths(statusRaw)
  const commands: string[] = ['git status']
  if (stashOid) commands.push(`git stash show --stat ${stashOid}`)
  else if (marker) commands.push(`git stash list --grep=${JSON.stringify(marker)}`)
  if (
    options.offerOriginalRestore &&
    stashOid &&
    currentBranch === operation.currentBranch &&
    headOid === operation.headOid &&
    status.length === 0
  ) {
    commands.push(`git stash apply --index ${stashOid}`)
  }
  commands.push('git diff', 'git diff --cached')
  return { stashOid, marker, currentBranch, headOid, status, commands, message }
}

interface StashEntry {
  selector: string
  oid: string
  subject: string
}

async function stashEntries(cwd: string): Promise<StashEntry[]> {
  const raw = await runGitRaw(cwd, ['stash', 'list', '--format=%gd%x09%H%x09%gs'])
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [selector, oid, ...subject] = line.split('\t')
      return { selector, oid, subject: subject.join('\t') }
    })
}

async function stashEntry(cwd: string, oid: string, marker?: string): Promise<StashEntry | null> {
  const entries = await stashEntries(cwd)
  return entries.find((entry) => entry.oid === oid && (!marker || entry.subject.includes(marker))) ?? null
}

async function stashEntryByMarker(cwd: string, marker: string): Promise<StashEntry | null> {
  const matches = (await stashEntries(cwd)).filter((entry) => entry.subject.includes(marker))
  return matches.length === 1 ? matches[0] : null
}

class OperationStashError extends Error {
  readonly oid?: string
  readonly marker: string

  constructor(message: string, marker: string, oid?: string) {
    super(message)
    this.name = 'OperationStashError'
    this.marker = marker
    this.oid = oid
  }
}

async function pushOperationStash(
  operation: PreparedLocalGitOperation,
  operationMarker?: string
): Promise<{ oid: string; marker: string }> {
  const marker = operationMarker ?? `maestrly-local:${randomUUID()}`
  const previous = await runGitOrNull(operation.cwd, ['rev-parse', '-q', '--verify', 'refs/stash'])
  try {
    await runGit(operation.cwd, ['stash', 'push', '-u', '-m', marker])
    const oid = await runGit(operation.cwd, ['rev-parse', '--verify', 'refs/stash'])
    if (!oid || oid === previous || !(await stashEntry(operation.cwd, oid, marker))) {
      const recovered = await stashEntryByMarker(operation.cwd, marker).catch(() => null)
      throw new OperationStashError(
        'Could not safely identify the stash created by the operation.',
        marker,
        recovered?.oid
      )
    }
    return { oid, marker }
  } catch (error) {
    if (error instanceof OperationStashError) throw error
    const recovered = await stashEntryByMarker(operation.cwd, marker).catch(() => null)
    throw new OperationStashError(
      `Stash creation could not be confirmed. ${error instanceof Error ? error.message : String(error)}`,
      marker,
      recovered?.oid
    )
  }
}

async function switchedToTarget(operation: PreparedLocalGitOperation): Promise<boolean> {
  const [branch, head] = await Promise.all([
    runGitOrNull(operation.cwd, ['branch', '--show-current']),
    runGitOrNull(operation.cwd, ['rev-parse', '--verify', 'HEAD']),
  ])
  return branch === operation.target.branch && head === operation.target.oid
}

async function finishSwitch(operation: PreparedLocalGitOperation): Promise<void> {
  if (!(await switchedToTarget(operation))) {
    throw new Error('The destination branch or commit changed during switching.')
  }
  for (const args of operation.target.postSwitchArgs) await runGit(operation.cwd, args)
}

async function appliedStateMatches(
  operation: PreparedLocalGitOperation,
  preservationFingerprint: string
): Promise<boolean> {
  if (!(await switchedToTarget(operation)) || (await hasUnmergedFiles(operation.cwd))) return false
  const after = await readStatus(operation.cwd)
  const allowedMarkers = new Set([...operation.status.markerPaths, ...(operation.status.targetMarkerPaths ?? [])])
  if (after.markerPaths.some((markerPath) => !allowedMarkers.has(markerPath))) return false
  if (after.stagedIndex !== operation.status.stagedIndex) return false
  const originalPaths = [...operation.status.trackedPaths, ...operation.status.changes.untracked]
  // Exit status, inventory, and metadata do not prove content. Compare content/mode of every dirty path
  // captured immediately before stashing before removing the recovery copy.
  return (await workingTreeFingerprint(operation.cwd, originalPaths)) === preservationFingerprint
}

async function compensateSwitchFailure(operation: PreparedLocalGitOperation, stashOid: string): Promise<void> {
  const [branch, head, status] = await Promise.all([
    runGitOrNull(operation.cwd, ['branch', '--show-current']),
    runGitOrNull(operation.cwd, ['rev-parse', '--verify', 'HEAD']),
    runGitOrNull(operation.cwd, ['status', '--porcelain=v2', '--untracked-files=all']),
  ])
  const clean = status === ''
  if (head !== operation.headOid || !clean) return
  if (branch !== operation.currentBranch) {
    // switch -c may create the branch before failing. Compensate only if original HEAD remains unchanged
    // and checkout is clean; otherwise restoration could destroy work.
    if (!(await exactOid(operation.cwd, `refs/heads/${operation.currentBranch}`))) return
    try {
      await runGit(operation.cwd, ['switch', '--no-overwrite-ignore', '--no-guess', operation.currentBranch])
    } catch {
      return
    }
  }
  await runGit(operation.cwd, ['stash', 'apply', '--index', stashOid]).catch(() => {})
}

export async function executePreparedLocalGit(operation: PreparedLocalGitOperation): Promise<LocalGitExecutionResult> {
  if (isLocalConversationAttachOnly(operation)) return { status: 'applied' }

  const current = await prepareLocalGitOperation(operation.cwd, operation.intent, operation.activity)
  if (current.blockers.length > 0) return { status: 'blocked', current }
  if (current.fingerprint !== operation.fingerprint) return { status: 'stale', current }
  const switchArgs = operation.target.switchArgs
  if (!switchArgs) return { status: 'applied' }

  if (operation.strategy !== 'stash-switch-apply') {
    try {
      await runGit(operation.cwd, switchArgs)
      await finishSwitch(operation)
      return { status: 'applied' }
    } catch (error) {
      return {
        status: 'recovery-required',
        recovery: await recoveryState(operation, error instanceof GitCommandError ? error.message : String(error)),
      }
    }
  }

  const preservationFingerprint = await workingTreeFingerprint(operation.cwd, [
    ...operation.status.trackedPaths,
    ...operation.status.changes.untracked,
  ])
  let stash: { oid: string; marker: string } | undefined
  try {
    stash = await pushOperationStash(operation)
  } catch (error) {
    const failed = error instanceof OperationStashError ? error : undefined
    return {
      status: 'recovery-required',
      stashOid: failed?.oid,
      marker: failed?.marker,
      recovery: await recoveryState(
        operation,
        `${error instanceof Error ? error.message : String(error)} The stash was preserved; keep the entry until you verify the index, working tree, and untracked files.`,
        failed?.oid,
        failed?.marker,
        { offerOriginalRestore: true }
      ),
    }
  }

  try {
    await runGit(operation.cwd, switchArgs)
    await finishSwitch(operation)
  } catch (error) {
    await compensateSwitchFailure(operation, stash.oid)
    return {
      status: 'recovery-required',
      stashOid: stash.oid,
      marker: stash.marker,
      recovery: await recoveryState(
        operation,
        `Branch switching failed. The stash was preserved. ${error instanceof Error ? error.message : String(error)}`,
        stash.oid,
        stash.marker
      ),
    }
  }

  try {
    await runGit(operation.cwd, ['stash', 'apply', '--index', stash.oid])
    if (!(await appliedStateMatches(operation, preservationFingerprint))) {
      throw new Error('Git did not fully restore the original index and working tree.')
    }
    return { status: 'applied', stashOid: stash.oid, marker: stash.marker }
  } catch (error) {
    return {
      status: 'recovery-required',
      stashOid: stash.oid,
      marker: stash.marker,
      recovery: await recoveryState(
        operation,
        `Reapplication was incomplete. Resolve the current state manually; the stash was preserved. ${error instanceof Error ? error.message : String(error)}`,
        stash.oid,
        stash.marker
      ),
    }
  }
}

/**
 * Automatically drop only when the operation's stash is still on top. If another process pushes one,
 * preserve everything rather than use a selector that can change between Git calls.
 */
export async function prepareWorktreeTransfer(
  cwd: string,
  branch: string,
  destination: string,
  activity: CwdActivityItem[] = []
): Promise<PreparedWorktreeTransfer> {
  const source = await prepareLocalGitOperation(cwd, { type: 'create-from-head', branch }, activity)
  const destinationPath = path.resolve(destination)
  const worktrees = await listWorktrees(cwd)
  const destinationCollision = worktrees.find(
    (item) => path.resolve(item.path) === destinationPath || item.branch === branch
  )
  if (destinationCollision) {
    source.blockers.push({
      code: 'branch-in-worktree',
      message: `Branch ${branch} or the destination already belongs to another worktree.`,
      paths: [destinationCollision.path],
    })
  }
  try {
    await fs.lstat(destinationPath)
    source.blockers.push({
      code: 'branch-in-worktree',
      message: 'The destination directory already exists.',
      paths: [destinationPath],
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  if (source.status.raw.length > 0 && (await runGitOrNull(cwd, ['rev-parse', '-q', '--verify', 'refs/stash']))) {
    source.blockers.push({
      code: 'git-operation',
      message: 'A stash already exists; restore or remove it before migrating a conversation with local changes.',
    })
  }
  source.preview.blockers = source.blockers
  const preservationFingerprint = await workingTreeFingerprint(cwd, [
    ...source.status.trackedPaths,
    ...source.status.changes.untracked,
  ])
  const operationToken = randomUUID()
  return {
    source,
    destination: destinationPath,
    preservationFingerprint,
    ignoredPaths: [],
    stashMarker: `maestrly-migration:${operationToken}`,
    rollbackQuarantine: `${destinationPath}.migration-rollback-${operationToken}`,
  }
}

async function worktreeTransferMatches(operation: PreparedWorktreeTransfer): Promise<boolean> {
  const { source, destination, preservationFingerprint } = operation
  const [branch, head, sourceStatus] = await Promise.all([
    runGitOrNull(destination, ['branch', '--show-current']),
    runGitOrNull(destination, ['rev-parse', '--verify', 'HEAD']),
    runGitOrNull(source.cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
  ])
  if (branch !== source.target.branch || head !== source.headOid || sourceStatus !== '') return false
  if (await hasUnmergedFiles(destination)) return false
  const after = await readStatus(destination)
  if (after.raw !== source.status.raw || after.stagedIndex !== source.status.stagedIndex) return false
  return (
    (await workingTreeFingerprint(destination, [...source.status.trackedPaths, ...source.status.changes.untracked])) ===
    preservationFingerprint
  )
}

export async function verifyWorktreeTransfer(operation: PreparedWorktreeTransfer): Promise<boolean> {
  try {
    return await worktreeTransferMatches(operation)
  } catch {
    return false
  }
}

/**
 * Check only invariants required to adopt a worktree containing new work; do not require its status to
 * remain identical to the migrated batch.
 */
export async function verifyWorktreeTransferDestination(operation: PreparedWorktreeTransfer): Promise<boolean> {
  try {
    const [branch, worktrees] = await Promise.all([
      runGitOrNull(operation.destination, ['branch', '--show-current']),
      listWorktrees(operation.source.cwd),
    ])
    return (
      branch === operation.source.target.branch &&
      worktrees.some((item) => path.resolve(item.path) === operation.destination)
    )
  } catch {
    return false
  }
}

export async function executePreparedWorktreeTransfer(
  operation: PreparedWorktreeTransfer
): Promise<WorktreeTransferExecutionResult> {
  const current = await prepareWorktreeTransfer(
    operation.source.cwd,
    operation.source.target.branch,
    operation.destination,
    operation.source.activity
  )
  if (current.source.blockers.length > 0) return { status: 'blocked', current }
  if (current.source.fingerprint !== operation.source.fingerprint) return { status: 'stale', current }

  let stash: { oid: string; marker: string } | undefined
  const dirty = operation.source.status.raw.length > 0
  if (dirty) {
    try {
      stash = await pushOperationStash(operation.source, operation.stashMarker)
    } catch (error) {
      const failed = error instanceof OperationStashError ? error : undefined
      return {
        status: 'recovery-required',
        stashOid: failed?.oid,
        marker: failed?.marker,
        recovery: await recoveryState(
          operation.source,
          `${error instanceof Error ? error.message : String(error)} O stash foi preservado.`,
          failed?.oid,
          failed?.marker,
          { offerOriginalRestore: true }
        ),
      }
    }
  }

  let worktreeCreated = false
  try {
    await fs.mkdir(path.dirname(operation.destination), { recursive: true })
    await runGit(operation.source.cwd, [
      'worktree',
      'add',
      '--no-track',
      '-b',
      operation.source.target.branch,
      operation.destination,
      operation.source.headOid,
    ])
    worktreeCreated = true
    if (stash) await runGit(operation.destination, ['stash', 'apply', '--index', stash.oid])
    if (!(await worktreeTransferMatches(operation))) {
      throw new Error('The destination worktree did not fully preserve the index and working tree.')
    }
    return { status: 'applied', stashOid: stash?.oid, marker: stash?.marker }
  } catch (error) {
    if (!worktreeCreated && stash) {
      await runGit(operation.source.cwd, ['stash', 'apply', '--index', stash.oid]).catch(() => {})
    }
    return {
      status: 'recovery-required',
      stashOid: stash?.oid,
      marker: stash?.marker,
      recovery: await recoveryState(
        operation.source,
        `Transfer to the worktree failed; nothing was removed automatically. ${error instanceof Error ? error.message : String(error)}`,
        stash?.oid,
        stash?.marker,
        { offerOriginalRestore: !worktreeCreated }
      ),
    }
  }
}

export async function findOperationStash(cwd: string, marker: string): Promise<string | null> {
  return (await stashEntryByMarker(cwd, marker))?.oid ?? null
}

/** Resume only recognizable transfer boundaries: before stash, after stash, or after worktree creation. */
export async function continuePreparedWorktreeTransfer(
  operation: PreparedWorktreeTransfer
): Promise<WorktreeTransferExecutionResult> {
  const recoveredStash = await stashEntryByMarker(operation.source.cwd, operation.stashMarker)
  if (await verifyWorktreeTransfer(operation)) {
    return {
      status: 'applied',
      stashOid: recoveredStash?.oid,
      marker: recoveredStash?.subject.includes(operation.stashMarker) ? operation.stashMarker : undefined,
    }
  }

  const [sourceStatus, worktrees] = await Promise.all([
    runGitOrNull(operation.source.cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    listWorktrees(operation.source.cwd),
  ])
  const target = worktrees.find((item) => path.resolve(item.path) === operation.destination)
  const dirtyExpected = operation.source.status.raw.length > 0

  // No effects occurred; normal execution can still fully revalidate the plan.
  if (!target && sourceStatus === operation.source.status.raw && !recoveredStash) {
    return executePreparedWorktreeTransfer(operation)
  }
  if (sourceStatus !== '') {
    return {
      status: 'recovery-required',
      stashOid: recoveredStash?.oid,
      marker: operation.stashMarker,
      recovery: await recoveryState(
        operation.source,
        'The source diverged during resume; no additional effects were applied.',
        recoveredStash?.oid,
        operation.stashMarker
      ),
    }
  }
  if (dirtyExpected && !recoveredStash) {
    return {
      status: 'recovery-required',
      marker: operation.stashMarker,
      recovery: await recoveryState(
        operation.source,
        'The source is clean, but the migration stash was not found.',
        undefined,
        operation.stashMarker
      ),
    }
  }

  try {
    if (!target) {
      await fs.mkdir(path.dirname(operation.destination), { recursive: true })
      await runGit(operation.source.cwd, [
        'worktree',
        'add',
        '--no-track',
        '-b',
        operation.source.target.branch,
        operation.destination,
        operation.source.headOid,
      ])
    } else if (target.branch !== operation.source.target.branch || target.head !== operation.source.headOid) {
      throw new Error('The existing worktree does not match the migration snapshot branch/HEAD.')
    }

    const destinationStatus = await runGitOrNull(operation.destination, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    if (recoveredStash && destinationStatus === '') {
      await runGit(operation.destination, ['stash', 'apply', '--index', recoveredStash.oid])
    }
    if (!(await verifyWorktreeTransfer(operation))) {
      throw new Error('Resuming did not fully reproduce the batch snapshot.')
    }
    return {
      status: 'applied',
      stashOid: recoveredStash?.oid,
      marker: recoveredStash ? operation.stashMarker : undefined,
    }
  } catch (error) {
    return {
      status: 'recovery-required',
      stashOid: recoveredStash?.oid,
      marker: operation.stashMarker,
      recovery: await recoveryState(
        operation.source,
        `Resuming the transfer requires manual review. ${error instanceof Error ? error.message : String(error)}`,
        recoveredStash?.oid,
        operation.stashMarker
      ),
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .lstat(target)
    .then(() => true)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
}

function rollbackEvidencePath(operation: PreparedWorktreeTransfer): string {
  return `${operation.rollbackQuarantine}.fingerprint`
}

function rollbackTombstonePath(operation: PreparedWorktreeTransfer): string {
  return `${operation.rollbackQuarantine}.deleting`
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(length).update(bytes)
}

async function fileDigest(absolute: string): Promise<Buffer> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolute)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    // Closing the file handle is part of completion before any worktree rename.
    stream.on('close', resolve)
  })
  return hash.digest()
}

async function directoryFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(absolute)
    const type = stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : stat.isDirectory() ? 'd' : 'o'
    updateFramed(hash, type)
    updateFramed(hash, relative)
    updateFramed(hash, String(stat.mode & 0o7777))
    if (type === 'l') {
      updateFramed(hash, await fs.readlink(absolute))
    } else if (type === 'f') {
      updateFramed(hash, await fileDigest(absolute))
    } else if (type === 'd') {
      const entries = await fs.readdir(absolute)
      for (const entry of entries.sort()) {
        await visit(path.join(absolute, entry), relative ? `${relative}/${entry}` : entry)
      }
    } else {
      updateFramed(hash, String(stat.size))
    }
  }
  await visit(root, '')
  return hash.digest('hex')
}

async function writeRollbackEvidence(operation: PreparedWorktreeTransfer): Promise<void> {
  const evidence = rollbackEvidencePath(operation)
  const temporary = `${evidence}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, await directoryFingerprint(operation.rollbackQuarantine), {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await fs.rename(temporary, evidence)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function pathMatchesRollbackEvidence(operation: PreparedWorktreeTransfer, target: string): Promise<boolean> {
  try {
    const expected = await fs.readFile(rollbackEvidencePath(operation), 'utf8')
    return expected === (await directoryFingerprint(target))
  } catch {
    return false
  }
}

async function removeVerifiedRollbackTree(operation: PreparedWorktreeTransfer, source: string): Promise<boolean> {
  const tombstone = rollbackTombstonePath(operation)
  if (await pathExists(tombstone)) return false
  try {
    await fs.rename(source, tombstone)
  } catch {
    return false
  }
  if (!(await pathMatchesRollbackEvidence(operation, tombstone))) {
    if (!(await pathExists(source))) await fs.rename(tombstone, source).catch(() => {})
    return false
  }
  await fs.rm(tombstone, { recursive: true })
  await fs.rm(rollbackEvidencePath(operation), { force: true })
  return !(await pathExists(source))
}

export async function verifyWorktreeTransferRolledBack(operation: PreparedWorktreeTransfer): Promise<boolean> {
  try {
    if (
      (await pathExists(operation.rollbackQuarantine)) ||
      (await pathExists(rollbackTombstonePath(operation))) ||
      (await pathExists(rollbackEvidencePath(operation)))
    )
      return false
    const [source, worktrees, branchOid] = await Promise.all([
      readStatus(operation.source.cwd),
      listWorktrees(operation.source.cwd),
      exactOid(operation.source.cwd, `refs/heads/${operation.source.target.branch}`),
    ])
    if (worktrees.some((item) => path.resolve(item.path) === operation.destination)) return false
    if (branchOid) return false
    if (source.raw !== operation.source.status.raw || source.stagedIndex !== operation.source.status.stagedIndex) {
      return false
    }
    return (
      (await workingTreeFingerprint(operation.source.cwd, [
        ...operation.source.status.trackedPaths,
        ...operation.source.status.changes.untracked,
      ])) === operation.preservationFingerprint
    )
  } catch {
    return false
  }
}

async function pristineWorktreeTarget(operation: PreparedWorktreeTransfer): Promise<boolean> {
  try {
    const [branch, head, status] = await Promise.all([
      runGitOrNull(operation.destination, ['branch', '--show-current']),
      runGitOrNull(operation.destination, ['rev-parse', '--verify', 'HEAD']),
      runGitOrNull(operation.destination, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    ])
    return branch === operation.source.target.branch && head === operation.source.headOid && status === ''
  } catch {
    return false
  }
}

export async function rollbackWorktreeTransfer(
  operation: PreparedWorktreeTransfer,
  stashOid?: string
): Promise<boolean> {
  const dirtyExpected = operation.source.status.raw.length > 0
  const operationStash = dirtyExpected ? await stashEntryByMarker(operation.source.cwd, operation.stashMarker) : null
  if (dirtyExpected) {
    if (!operationStash) return false
    if (stashOid && operationStash.oid !== stashOid) return false
    stashOid = operationStash.oid
  }
  if (await verifyWorktreeTransferRolledBack(operation)) return true
  const quarantine = operation.rollbackQuarantine
  const tombstone = rollbackTombstonePath(operation)
  if (await pathExists(tombstone)) {
    if ((await pathExists(quarantine)) || (await pathExists(operation.destination))) return false
    if (!(await pathMatchesRollbackEvidence(operation, tombstone))) return false
    await fs.rm(tombstone, { recursive: true })
    await fs.rm(rollbackEvidencePath(operation), { force: true })
  }
  if (
    !(await pathExists(quarantine)) &&
    !(await pathExists(tombstone)) &&
    (await pathExists(rollbackEvidencePath(operation)))
  ) {
    await fs.rm(rollbackEvidencePath(operation), { force: true })
  }
  if (await pathExists(quarantine)) {
    if (await pathExists(operation.destination)) return false
    const worktrees = await listWorktrees(operation.source.cwd)
    const destinationRegistered = worktrees.some((item) => path.resolve(item.path) === operation.destination)
    if (destinationRegistered) {
      const quarantinedPlan = { ...operation, destination: quarantine }
      const applied = await verifyWorktreeTransfer(quarantinedPlan)
      const pristine = !applied && (await pristineWorktreeTarget(quarantinedPlan))
      if (!applied && !pristine) return false
      await fs.rename(quarantine, operation.destination)
    } else {
      // Delete content only if it matches evidence saved before removing Git registration. Rename to
      // tombstone closes races with new work recreated at quarantine paths.
      if (!(await removeVerifiedRollbackTree(operation, quarantine))) return false
    }
  }
  const sourceStatus = await runGitOrNull(operation.source.cwd, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ])
  if (sourceStatus !== '') return false
  const worktrees = await listWorktrees(operation.source.cwd)
  const target = worktrees.find((item) => path.resolve(item.path) === operation.destination)
  if (!target && (await pathExists(operation.destination))) return false
  if (target) {
    // Accept a fully applied batch or a pristine worktree after worktree add but before stash apply. Treat
    // other states as divergent work.
    const applied = await verifyWorktreeTransfer(operation)
    const pristine = !applied && (await pristineWorktreeTarget(operation))
    if (!applied && !pristine) return false
    const ignored = await runGitOrNull(operation.destination, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ])
    if (ignored !== '') return false
    // The expected dirty worktree requires forced registration removal. First isolate its directory
    // atomically; force then removes only the absent-path Git record, never quarantined content. Preserve
    // quarantine on divergence.
    try {
      await fs.rename(operation.destination, quarantine)
      const quarantinedPlan = { ...operation, destination: quarantine }
      const quarantineMatches = applied
        ? await verifyWorktreeTransfer(quarantinedPlan)
        : await pristineWorktreeTarget(quarantinedPlan)
      if (!quarantineMatches) {
        if (
          !(await fs
            .lstat(operation.destination)
            .then(() => false)
            .catch(() => true))
        )
          return false
        await fs.rename(quarantine, operation.destination)
        return false
      }
      const quarantinedIgnored = await runGitOrNull(quarantine, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
      ])
      if (quarantinedIgnored !== '') {
        await fs.rename(quarantine, operation.destination).catch(() => {})
        return false
      }
      await writeRollbackEvidence(operation)
      await runGit(operation.source.cwd, ['worktree', 'remove', '--force', operation.destination])
      if (!(await removeVerifiedRollbackTree(operation, quarantine))) return false
    } catch {
      try {
        await fs.lstat(operation.destination)
      } catch {
        await fs.rename(quarantine, operation.destination).catch(() => {})
      }
      return false
    }
  }
  const branchRef = `refs/heads/${operation.source.target.branch}`
  const branchOid = await exactOid(operation.source.cwd, branchRef)
  if (branchOid) {
    try {
      await runGit(operation.source.cwd, ['update-ref', '-d', branchRef, operation.source.headOid])
    } catch {
      return false
    }
  }
  if (stashOid) {
    await runGit(operation.source.cwd, ['stash', 'apply', '--index', stashOid])
    const [restoredStatus, restoredFingerprint] = await Promise.all([
      readStatus(operation.source.cwd),
      workingTreeFingerprint(operation.source.cwd, [
        ...operation.source.status.trackedPaths,
        ...operation.source.status.changes.untracked,
      ]),
    ])
    return (
      restoredStatus.raw === operation.source.status.raw &&
      restoredStatus.stagedIndex === operation.source.status.stagedIndex &&
      restoredFingerprint === operation.preservationFingerprint
    )
  }
  return !dirtyExpected
}

/**
 * Remove the recovery ref only when it is the sole stash entry. Atomic update-ref -d compares OID so
 * concurrent pushes cannot lose refs. With other stashes, retain data for manual recovery instead of
 * relying on mutable @{0}.
 */
export async function dropOperationStash(cwd: string, oid: string, marker: string): Promise<boolean> {
  const entries = await stashEntries(cwd)
  if (entries.length !== 1 || entries[0].oid !== oid || !entries[0].subject.includes(marker)) return false
  try {
    await runGit(cwd, ['update-ref', '-d', 'refs/stash', oid])
  } catch {
    return false
  }
  return !(await stashEntry(cwd, oid, marker))
}
