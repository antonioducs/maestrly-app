import { createHash } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  CONVERSATION_MOVE_PACKAGE_FORMAT,
  CONVERSATION_MOVE_PACKAGE_VERSION,
  type ExportedPackage,
  type MoveBlocker,
  type MoveWarningCode,
  type SourceInspection,
} from '../../shared/conversation-move'
import { inspectMigrationSidecars, validateIgnoredSelection } from '../conversation-migration/sidecars'
import { findIncompleteMigrationForScope } from '../conversation-migration/store'
import type { QuiesceResult } from '../conversation-migration/quiesce'
import { inspectCwdActivity } from '../cwd-activity-coordinator'
import { runGitOrNull } from '../git-command'
import { countOtherRunningConversationsInCwd, getConversation, getWorkspace } from '../store'
import { sendToMainTargets } from '../window-ipc'
import { deleteConversation } from '../workspace-service'
import { getDb } from '../store/db'
import { computeMoveDigest } from './digest'
import {
  activeMoveEndpointForConversation,
  getMoveEndpoint,
  insertMoveEndpoint,
  type MoveEndpointRecord,
  updateMoveEndpoint,
} from './endpoint-store'
import { MoveError } from './errors'
import { collectConversationFiles, hashConversationFiles } from './files'
import {
  createGitSnapshot,
  dropMoveRefs,
  type GitSnapshot,
  inspectGitSource,
  isAncestor,
  keepMovedBackupRef,
  worktreeTreeOid,
} from './git-snapshot'
import { acquireMoveLease, ensureMoveLease, releaseMoveLease } from './leases'
import { BUNDLE_RELATIVE, writeMovePackage } from './package'
import { readConversationRows } from './rows'
import { moveStagingDirectory, removeMoveStaging } from './staging'

/**
 * The source end of a move, on the host that has the conversation: it inspects it, freezes it (stops its runtime and
 * leases its folder), exports it as a package, and once the destination holds a verified copy, releases it. Until
 * then the source is untouched but for refs under `refs/maestrly/move/`, so thawing it gives everything back.
 */
export interface SourceDeps {
  quiesce: (conversationId: string, cwd: string) => Promise<QuiesceResult>
  appVersion: () => string
}

const RUNNING_STATUSES = new Set(['working', 'waiting', 'asking'])
const ALWAYS_WARNINGS: MoveWarningCode[] = ['provider-session-restarts', 'runtime-not-moved', 'project-memory-stays']
const FROZEN_STATES = new Set(['frozen', 'exported'])

function messageStats(conversationId: string): { messages: number; lastSeq: number } {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq), -1) AS last FROM chat_messages WHERE conversation_id = ?')
    .get(conversationId) as { n: number; last: number }
  return { messages: Number(row.n), lastSeq: Number(row.last) }
}

function emptyInspection(conversationId: string, name: string, cwd: string, blocker: MoveBlocker): SourceInspection {
  return {
    conversationId,
    conversationName: name,
    cwd,
    mode: 'worktree',
    branch: null,
    headOid: '',
    remoteUrl: null,
    defaultBranch: '',
    commitsAhead: 0,
    changes: { staged: [], unstaged: [], untracked: [] },
    ignored: [],
    transcript: { messages: 0, files: 0, fileBytes: 0 },
    fingerprint: '',
    blockers: [blocker],
    warnings: [],
  }
}

async function inspect(conversationId: string, ownOperationId?: string): Promise<SourceInspection> {
  const conversation = getConversation(conversationId)
  if (!conversation) throw new MoveError('not-found', 'Conversation not found.')
  const notEligible = (message: string) =>
    emptyInspection(conversation.id, conversation.name, conversation.cwd, { code: 'not-eligible', message })
  if (
    conversation.scope !== 'project' ||
    conversation.botOrigin ||
    conversation.isMulti !== 0 ||
    conversation.archived !== 0
  )
    return notEligible('Only an active single-repository project conversation can be moved.')
  let git: Awaited<ReturnType<typeof inspectGitSource>>
  let worktreeTree: string
  try {
    git = await inspectGitSource(conversation.cwd)
    worktreeTree = await worktreeTreeOid(conversation.cwd)
  } catch (error) {
    return notEligible(`The conversation's folder cannot be read: ${(error as Error).message}`)
  }
  const blockers: MoveBlocker[] = []
  if (RUNNING_STATUSES.has(conversation.status))
    blockers.push({ code: 'running', message: 'The conversation is running. Stop it before moving it.' })
  const endpoint = activeMoveEndpointForConversation(conversation.id)
  if (
    findIncompleteMigrationForScope(conversation.id, conversation.cwd) ||
    (endpoint && endpoint.operationId !== ownOperationId)
  )
    blockers.push({
      code: 'incomplete-operation',
      message: 'Another migration or move of this conversation has not finished.',
    })
  if (countOtherRunningConversationsInCwd(conversation.cwd, conversation.id) > 0)
    blockers.push({ code: 'cwd-active', message: 'Another conversation is running in this folder.' })
  blockers.push(...git.blockers)
  const ignored = (await inspectMigrationSidecars(conversation.cwd, git.headOid)).ignored
  const files = await collectConversationFiles({
    conversationId: conversation.id,
    cwd: conversation.cwd,
    selectedIgnoredPaths: [],
  })
  const stats = messageStats(conversation.id)
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        headOid: git.headOid,
        branch: git.branch,
        statusRaw: git.statusRaw,
        stagedIndex: git.stagedIndex,
        worktreeTree,
        ...stats,
      })
    )
    .digest('hex')
  return {
    conversationId: conversation.id,
    conversationName: conversation.name,
    cwd: conversation.cwd,
    mode: conversation.mode,
    branch: git.branch,
    headOid: git.headOid,
    remoteUrl: git.remoteUrl,
    defaultBranch: git.defaultBranch,
    commitsAhead: git.commitsAhead,
    changes: git.changes,
    ignored,
    transcript: { messages: stats.messages, ...files.stats },
    fingerprint,
    blockers,
    warnings: [
      ...ALWAYS_WARNINGS,
      ...(conversation.mode === 'local' ? (['source-checkout-kept'] as const) : []),
      ...git.warnings,
    ],
  }
}

export function inspectSource(input: { conversationId: string }): Promise<SourceInspection> {
  return inspect(input.conversationId)
}

/** Whether the conversation's HEAD descends from `ancestorOid`; false when this checkout does not have that commit. */
export async function checkSourceAncestry(input: { conversationId: string; ancestorOid: string }): Promise<boolean> {
  const conversation = getConversation(input.conversationId)
  if (!conversation) throw new MoveError('not-found', 'Conversation not found.')
  if (!/^[0-9a-f]{40,64}$/i.test(input.ancestorOid)) return false
  if ((await runGitOrNull(conversation.cwd, ['cat-file', '-e', `${input.ancestorOid}^{commit}`])) === null) return false
  return isAncestor(conversation.cwd, input.ancestorOid, 'HEAD')
}

function sourceJournal(operationId: string): MoveEndpointRecord {
  const endpoint = getMoveEndpoint(operationId, 'source')
  if (!endpoint) throw new MoveError('not-found', 'This host has no source for that move.')
  return endpoint
}

/** Where refs of the conversation's repository are kept, whether or not its checkout still exists. */
const repositoryOf = (endpoint: MoveEndpointRecord): string =>
  typeof endpoint.data.top === 'string' && endpoint.data.top ? endpoint.data.top : (endpoint.cwd ?? '')

async function thaw(endpoint: MoveEndpointRecord): Promise<void> {
  const top = repositoryOf(endpoint)
  if (top) await dropMoveRefs(top, endpoint.operationId, 'move')
  await removeMoveStaging(endpoint.operationId)
  releaseMoveLease(endpoint.operationId, 'source')
  updateMoveEndpoint(endpoint.operationId, 'source', { state: 'thawed' })
}

export async function freezeSource(
  input: { operationId: string; conversationId: string; fingerprint: string },
  deps: SourceDeps
): Promise<void> {
  const existing = getMoveEndpoint(input.operationId, 'source')
  if (existing) {
    if (!FROZEN_STATES.has(existing.state))
      throw new MoveError('stale', 'This move already left the source; prepare it again.')
    if (existing.cwd && !ensureMoveLease(input.operationId, 'source', existing.cwd))
      throw new MoveError('running', "The conversation's folder is in use by another operation.")
    return
  }
  const conversation = getConversation(input.conversationId)
  if (!conversation) throw new MoveError('not-found', 'Conversation not found.')
  const cwd = conversation.cwd
  if (!acquireMoveLease(input.operationId, 'source', cwd, ['pty', 'chat', 'terminal']))
    throw new MoveError('running', "The conversation's folder is in use by another operation.")
  const top =
    conversation.scope === 'project' ? (getWorkspace(conversation.workspaceId)?.path ?? cwd) : conversation.cwd
  insertMoveEndpoint({
    operationId: input.operationId,
    role: 'source',
    conversationId: conversation.id,
    state: 'frozen',
    cwd,
    data: { top },
  })
  const fail = async (error: MoveError): Promise<never> => {
    await thaw(sourceJournal(input.operationId))
    throw error
  }
  const quiesced = await deps.quiesce(conversation.id, cwd)
  if (!quiesced.ok) return fail(new MoveError('running', `Could not stop: ${quiesced.failed.join(', ')}.`))
  const residual = inspectCwdActivity(cwd).filter((item) => item.blocking)
  if (residual.length > 0)
    return fail(
      new MoveError(
        'running',
        `The folder still has active execution (${residual.map((item) => item.kind).join(', ')}).`
      )
    )
  const now = await inspect(conversation.id, input.operationId)
  if (now.blockers.length > 0) return fail(new MoveError('stale', now.blockers[0].message))
  if (now.fingerprint !== input.fingerprint)
    return fail(new MoveError('stale', 'The conversation changed after the preview.'))
}

const packageName = (name: string): string =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'conversation'
  }.maestrly-move`

async function fileExists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false
  )
}

export async function exportSource(
  input: { operationId: string; selectedIgnoredPaths: string[]; confirmedSensitivePaths: string[] },
  deps: SourceDeps
): Promise<ExportedPackage> {
  const endpoint = sourceJournal(input.operationId)
  const cached = endpoint.data.package as ExportedPackage | undefined
  if (endpoint.state === 'exported' && cached && (await fileExists(cached.path))) return cached
  if (!FROZEN_STATES.has(endpoint.state)) throw new MoveError('stale', 'The source of this move is no longer frozen.')
  const conversation = getConversation(endpoint.conversationId)
  if (!conversation || !endpoint.cwd) throw new MoveError('not-found', 'Conversation not found.')
  if (!ensureMoveLease(input.operationId, 'source', endpoint.cwd))
    throw new MoveError('running', "The conversation's folder is in use by another operation.")
  const cwd = endpoint.cwd
  const git = await inspectGitSource(cwd)
  const selected = validateIgnoredSelection(
    (await inspectMigrationSidecars(cwd, git.headOid)).ignored,
    input.selectedIgnoredPaths,
    input.confirmedSensitivePaths
  )
  const staging = await moveStagingDirectory(input.operationId)
  const bundlePath = path.join(staging, BUNDLE_RELATIVE)
  const packagePath = path.join(staging, packageName(conversation.name))
  await rm(bundlePath, { force: true })
  await rm(packagePath, { force: true })
  const snapshot: GitSnapshot = await createGitSnapshot(cwd, input.operationId, bundlePath)
  const rows = readConversationRows(conversation.id)
  const files = await collectConversationFiles({ conversationId: conversation.id, cwd, selectedIgnoredPaths: selected })
  const digest = await computeMoveDigest(conversation.id, await hashConversationFiles(conversation.id, cwd), snapshot)
  const written = await writeMovePackage(packagePath, {
    manifest: {
      format: CONVERSATION_MOVE_PACKAGE_FORMAT,
      version: CONVERSATION_MOVE_PACKAGE_VERSION,
      appVersion: deps.appVersion(),
      operationId: input.operationId,
      conversationId: conversation.id,
      createdAt: Date.now(),
      digest,
      snapshot,
    },
    rows,
    sources: [...files.sources, { kind: 'bundle', relative: BUNDLE_RELATIVE, absolute: bundlePath }],
  })
  await rm(bundlePath, { force: true })
  const exported: ExportedPackage = {
    path: written.path,
    name: path.basename(written.path),
    size: written.size,
    sha256: written.sha256,
    digest,
  }
  updateMoveEndpoint(input.operationId, 'source', { state: 'exported', data: { snapshot, package: exported } })
  return exported
}

/**
 * The destination holds a verified copy: the conversation leaves this host. Its branch stays, with the moved working
 * tree under `refs/maestrly/moved/<operation>`, and the package stays in staging as a backup.
 */
export async function releaseSource(input: { operationId: string }): Promise<void> {
  const endpoint = sourceJournal(input.operationId)
  if (endpoint.state === 'released') return
  if (endpoint.state !== 'exported' && endpoint.state !== 'releasing')
    throw new MoveError('stale', 'The source of this move was not exported.')
  // Out of the active states: the guard against deleting a moving conversation lets this deletion through.
  updateMoveEndpoint(input.operationId, 'source', { state: 'releasing' })
  const top = repositoryOf(endpoint)
  if (top) await keepMovedBackupRef(top, input.operationId)
  if (getConversation(endpoint.conversationId))
    await deleteConversation(endpoint.conversationId, { preserveBranch: true })
  releaseMoveLease(input.operationId, 'source')
  updateMoveEndpoint(input.operationId, 'source', { state: 'released' })
  sendToMainTargets('workspace:changed')
}

/** Gives the conversation back to this host, as it was before the move. */
export async function thawSource(input: { operationId: string }): Promise<void> {
  const endpoint = getMoveEndpoint(input.operationId, 'source')
  // Nothing was frozen: the move stopped before reaching the source.
  if (!endpoint || endpoint.state === 'thawed') return
  if (endpoint.state === 'released' || endpoint.state === 'releasing')
    throw new MoveError('already-released', 'The conversation already left this host.')
  await thaw(endpoint)
}
