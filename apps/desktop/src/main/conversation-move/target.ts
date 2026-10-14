import { randomUUID } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  ImportedConversation,
  ImportTargetInput,
  MoveBlocker,
  MoveDigest,
  MoveEndpointProgress,
  MoveTargetWorkspacePlan,
  TargetInspection,
  TargetInspectionInput,
} from '../../shared/conversation-move'
import { isSafeProjectName, suggestProjectName } from '../../shared/project-setup'
import { sameGitRemote } from '../../shared/workspace-creation'
import { migrationWorktreeDir } from '../app-paths'
import { runGitOrNull } from '../git-command'
import { listWorktrees } from '../git-service'
import type { projectSetupService } from '../project-setup/service'
import { getProjectsDirectory } from '../projects-directory'
import { getConversation, getWorkspace, listWorkspaces } from '../store'
import { hashFile } from '../transfer-io'
import { sendToMainTargets } from '../window-ipc'
import { readRepositoryOrigin } from '../workspace-creation-service'
import { computeMoveDigest } from './digest'
import { getMoveEndpoint, insertMoveEndpoint, type MoveEndpointRecord, updateMoveEndpoint } from './endpoint-store'
import { MoveError } from './errors'
import { hashConversationFiles, removeRestoredConversationFiles, restoreConversationFiles } from './files'
import {
  applyGitSnapshot,
  branchName,
  dropMoveRefs,
  type GitSnapshot,
  isAncestor,
  rollbackAppliedSnapshot,
  verifyAppliedSnapshot,
} from './git-snapshot'
import { acquireMoveLease, ensureMoveLease, releaseMoveLease } from './leases'
import { readMovePackage } from './package'
import { deleteImportedConversationRows, insertConversationRows } from './rows'
import { moveStagingDirectory, removeMoveStaging } from './staging'

/**
 * The target end of a move, on the host that receives the conversation: it finds or sets up the project, imports
 * the package into a new worktree with the conversation's rows and files, and holds it leased until the coordinator
 * commits it. Discarding gives the host back what it had, keeping a project it cloned.
 */
export interface TargetDeps {
  appVersion: () => string
  setup: Pick<typeof projectSetupService, 'execute'>
  onProgress?: (progress: MoveEndpointProgress) => void
}

const INSPECT_TIMEOUT_MS = 30_000
const FREE_ALTERNATIVES = 9

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false
  )
}

async function originOf(dir: string): Promise<string | null> {
  return readRepositoryOrigin(dir, AbortSignal.timeout(INSPECT_TIMEOUT_MS)).catch(() => null)
}

async function findWorkspace(remoteUrl: string): Promise<MoveTargetWorkspacePlan | null> {
  for (const workspace of listWorkspaces()) {
    const origin = await originOf(workspace.path)
    if (origin && sameGitRemote(origin, remoteUrl))
      return { kind: 'existing', workspaceId: workspace.id, name: workspace.name, path: workspace.path }
  }
  return null
}

const validBranch = async (branch: string): Promise<boolean> =>
  (await runGitOrNull(process.cwd(), ['check-ref-format', `refs/heads/${branch}`])) !== null

const localBranchTip = (top: string, branch: string): Promise<string | null> =>
  runGitOrNull(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])

async function freeAlternative(top: string | null, branch: string): Promise<string> {
  for (let index = 1; index <= FREE_ALTERNATIVES; index++) {
    const candidate = index === 1 ? `${branch}-moved` : `${branch}-moved-${index}`
    if (!top || !(await localBranchTip(top, candidate))) return candidate
  }
  return `${branch}-moved-${randomUUID().slice(0, 8)}`
}

export async function inspectTarget(input: TargetInspectionInput): Promise<TargetInspection> {
  const blockers: MoveBlocker[] = []
  if (getConversation(input.conversationId))
    blockers.push({ code: 'target-has-conversation', message: 'This host already has this conversation.' })
  let workspace = await findWorkspace(input.remoteUrl)
  if (!workspace) {
    const parent = getProjectsDirectory()
    if (!parent) {
      blockers.push({
        code: 'projects-directory-missing',
        message: 'The destination has no projects folder to clone the project into.',
      })
    } else {
      const suggested = suggestProjectName(input.remoteUrl)
      const name = isSafeProjectName(suggested) ? suggested : 'project'
      const destination = path.join(parent, name)
      if (!(await exists(destination))) {
        workspace = {
          kind: 'clone',
          parentPath: parent,
          name,
          remoteUrl: input.remoteUrl,
          defaultBranch: input.defaultBranch,
        }
      } else {
        const origin = await originOf(destination)
        if (origin && sameGitRemote(origin, input.remoteUrl)) workspace = { kind: 'adopt', path: destination, name }
        else
          blockers.push({
            code: 'clone-destination-exists',
            message: `${destination} already exists and is not a clone of this project.`,
            paths: [destination],
          })
      }
    }
  }

  const name = input.branch
  if (!(await validBranch(name)))
    blockers.push({ code: 'target-branch-invalid', message: `${name} is not a valid branch name.` })
  const top = workspace && workspace.kind !== 'clone' ? workspace.path : null
  let branch: TargetInspection['branch'] = {
    name,
    state: 'absent',
    ancestor: null,
    freeAlternative: await freeAlternative(top, name),
  }
  if (workspace?.kind === 'clone') {
    // The clone checks out its default branch in its own folder.
    if (name === workspace.defaultBranch) branch = { ...branch, state: 'checked-out' }
  } else if (top) {
    const tip = await localBranchTip(top, name)
    const checkedOut = (await listWorktrees(top)).some((worktree) => branchName(worktree.branch) === name)
    const state = checkedOut ? 'checked-out' : !tip ? 'absent' : tip === input.headOid ? 'same' : 'exists'
    let ancestor: boolean | null = null
    if (
      tip &&
      tip !== input.headOid &&
      (await runGitOrNull(top, ['cat-file', '-e', `${input.headOid}^{commit}`])) !== null
    )
      ancestor = await isAncestor(top, tip, input.headOid)
    branch = { ...branch, state, ...(tip ? { tipOid: tip } : {}), ancestor }
  }
  return { workspace, branch, blockers }
}

function targetJournal(operationId: string): MoveEndpointRecord {
  const endpoint = getMoveEndpoint(operationId, 'target')
  if (!endpoint) throw new MoveError('not-found', 'This host has no target for that move.')
  return endpoint
}

export async function prepareTargetWorkspace(
  input: { operationId: string; conversationId: string; workspace: MoveTargetWorkspacePlan },
  deps: TargetDeps
): Promise<{ workspaceId: string }> {
  const existing = getMoveEndpoint(input.operationId, 'target')
  const known = existing?.data.workspaceId
  if (typeof known === 'string' && getWorkspace(known)) return { workspaceId: known }
  if (existing && existing.state !== 'workspace-ready')
    throw new MoveError('stale', 'The destination of this move already went past preparing its project.')
  let workspaceId: string
  let cloned = false
  if (input.workspace.kind === 'existing') {
    if (!getWorkspace(input.workspace.workspaceId))
      throw new MoveError('not-found', 'The destination project was removed.')
    workspaceId = input.workspace.workspaceId
  } else {
    const plan = input.workspace
    const ctx = {
      signal: new AbortController().signal,
      emit: (progress: { phase: string; percent?: number }) =>
        deps.onProgress?.({
          operationId: input.operationId,
          step: 'clone',
          phase: progress.phase,
          ...(progress.percent === undefined ? {} : { percent: progress.percent }),
        }),
      markCommitted() {},
      waitForEmptyRemoteDecision: async () => 'cancel' as const,
    }
    const result = await deps.setup.execute(
      plan.kind === 'adopt'
        ? { operationId: randomUUID(), kind: 'open', path: plan.path }
        : {
            operationId: randomUUID(),
            kind: 'clone',
            parentPath: plan.parentPath,
            name: plan.name,
            remoteUrl: plan.remoteUrl,
            defaultBranch: plan.defaultBranch,
          },
      ctx
    )
    if (result.status !== 'success') {
      const code = result.status === 'error' ? result.error.code : result.status
      throw new MoveError(
        'clone-failed',
        `${code}: check the destination's Git credentials (on a remote host, configure them from its terminal).`
      )
    }
    workspaceId = result.workspace.id
    cloned = plan.kind === 'clone' && !result.reused
  }
  if (existing) updateMoveEndpoint(input.operationId, 'target', { data: { workspaceId, cloned } })
  else
    insertMoveEndpoint({
      operationId: input.operationId,
      role: 'target',
      conversationId: input.conversationId,
      state: 'workspace-ready',
      cwd: null,
      data: { workspaceId, cloned },
    })
  sendToMainTargets('workspace:changed')
  return { workspaceId }
}

/** Removes what an import put on this host: the conversation it inserted, its files, its worktree and branch. */
async function undoImport(endpoint: MoveEndpointRecord): Promise<void> {
  const data = endpoint.data
  const destination = typeof data.destination === 'string' ? data.destination : ''
  const top = typeof data.top === 'string' ? data.top : ''
  const conversation = getConversation(endpoint.conversationId)
  // Only the conversation this import inserted: another one with the same id is never touched.
  if (conversation && destination && conversation.cwd === destination)
    deleteImportedConversationRows(endpoint.conversationId)
  if (!getConversation(endpoint.conversationId)) await removeRestoredConversationFiles(endpoint.conversationId)
  if (top && destination) {
    const branch = String(data.branch ?? '')
    const headOid = String(data.headOid ?? '')
    let branchCreated = data.branchCreated === true
    // Interrupted between creating the branch and recording it: a new branch at the moved HEAD is this import's.
    if (data.branchCreated === undefined && data.branchAction === 'create' && branch)
      branchCreated = (await localBranchTip(top, branch)) === headOid
    await rollbackAppliedSnapshot({
      top,
      destination,
      operationId: endpoint.operationId,
      branch,
      branchCreated,
      previousTipOid: typeof data.previousTipOid === 'string' ? data.previousTipOid : null,
      headOid,
    })
  }
  releaseMoveLease(endpoint.operationId, 'target')
}

export async function importTarget(input: ImportTargetInput, deps: TargetDeps): Promise<ImportedConversation> {
  let endpoint = targetJournal(input.operationId)
  const cached = endpoint.data.imported as ImportedConversation | undefined
  if (endpoint.state === 'imported' && cached) {
    if (!ensureMoveLease(input.operationId, 'target', cached.cwd))
      throw new MoveError('running', 'The imported folder is in use by another operation.')
    return cached
  }
  if (endpoint.state === 'importing') {
    // A previous attempt stopped halfway: start over from a clean destination.
    await undoImport(endpoint)
    updateMoveEndpoint(input.operationId, 'target', { state: 'workspace-ready', cwd: null })
    endpoint = targetJournal(input.operationId)
  }
  if (endpoint.state !== 'workspace-ready') throw new MoveError('stale', 'The destination of this move is not ready.')
  const workspace = getWorkspace(input.workspaceId)
  if (!workspace) throw new MoveError('not-found', 'The destination project was removed.')
  if ((await hashFile(input.packagePath).catch(() => null)) !== input.sha256)
    throw new MoveError('package-invalid', 'The package on the destination differs from the exported one.')
  const staging = await moveStagingDirectory(input.operationId)
  const extract = path.join(staging, 'extract')
  await rm(extract, { recursive: true, force: true })
  const read = await readMovePackage(input.packagePath, extract, { appVersion: deps.appVersion() })
  const { manifest } = read
  const conversationId = manifest.conversationId
  if (conversationId !== endpoint.conversationId)
    throw new MoveError('package-invalid', 'The package holds another conversation.')
  if (getConversation(conversationId))
    throw new MoveError('conversation-exists', 'This host already has this conversation.')
  const bundle = read.files.find((file) => file.kind === 'bundle')
  if (!bundle) throw new MoveError('package-invalid', 'The package has no Git bundle.')
  const { plan } = input
  const destination = migrationWorktreeDir(workspace.id, plan.branch, input.operationId)
  updateMoveEndpoint(input.operationId, 'target', {
    state: 'importing',
    cwd: destination,
    data: {
      destination,
      top: workspace.path,
      branch: plan.branch,
      branchAction: plan.branchAction,
      headOid: manifest.snapshot.headOid,
    },
  })
  deps.onProgress?.({ operationId: input.operationId, step: 'import', phase: 'git' })
  const applied = await applyGitSnapshot({
    top: workspace.path,
    destination,
    operationId: input.operationId,
    bundlePath: bundle.absolute,
    snapshot: manifest.snapshot,
    branch: plan.branch,
    branchAction: plan.branchAction,
    ...(plan.expectedTipOid ? { expectedTipOid: plan.expectedTipOid } : {}),
  })
  updateMoveEndpoint(input.operationId, 'target', { data: { ...applied } })
  if (!acquireMoveLease(input.operationId, 'target', destination))
    throw new MoveError('running', 'The imported folder is in use by another operation.')
  deps.onProgress?.({ operationId: input.operationId, step: 'import', phase: 'files' })
  await restoreConversationFiles({ conversationId, cwd: destination, files: read.files })
  insertConversationRows(read.rows, { workspaceId: workspace.id, branch: plan.branch, cwd: destination })
  await rm(extract, { recursive: true, force: true })
  const imported: ImportedConversation = {
    conversationId,
    workspaceId: workspace.id,
    cwd: destination,
    branch: plan.branch,
  }
  updateMoveEndpoint(input.operationId, 'target', {
    state: 'imported',
    data: { imported, snapshot: manifest.snapshot },
  })
  sendToMainTargets('workspace:changed')
  return imported
}

function importedOf(endpoint: MoveEndpointRecord): { imported: ImportedConversation; snapshot: GitSnapshot } {
  const imported = endpoint.data.imported as ImportedConversation | undefined
  const snapshot = endpoint.data.snapshot as GitSnapshot | undefined
  if (endpoint.state !== 'imported' || !imported || !snapshot)
    throw new MoveError('stale', 'The destination of this move has not imported it.')
  return { imported, snapshot }
}

export async function verifyTarget(input: { operationId: string }): Promise<MoveDigest> {
  const { imported, snapshot } = importedOf(targetJournal(input.operationId))
  if (!(await verifyAppliedSnapshot(imported.cwd, snapshot, imported.branch)))
    throw new MoveError('verification-failed', "The destination's checkout differs from the exported one.")
  return computeMoveDigest(
    imported.conversationId,
    await hashConversationFiles(imported.conversationId, imported.cwd),
    snapshot
  )
}

/** The source let the conversation go: it is this host's now. */
export async function commitTarget(input: { operationId: string }): Promise<void> {
  const endpoint = targetJournal(input.operationId)
  if (endpoint.state === 'committed') return
  importedOf(endpoint)
  releaseMoveLease(input.operationId, 'target')
  if (typeof endpoint.data.top === 'string') await dropMoveRefs(endpoint.data.top, input.operationId, 'incoming')
  await removeMoveStaging(input.operationId)
  updateMoveEndpoint(input.operationId, 'target', { state: 'committed' })
  sendToMainTargets('workspace:changed')
}

/** Gives the host back what it had before the import; a project it cloned stays. */
export async function discardTarget(input: { operationId: string }): Promise<void> {
  const endpoint = getMoveEndpoint(input.operationId, 'target')
  if (!endpoint || endpoint.state === 'discarded') return
  if (endpoint.state === 'committed') throw new MoveError('stale', 'The destination already owns this conversation.')
  if (endpoint.state === 'importing' || endpoint.state === 'imported') await undoImport(endpoint)
  await removeMoveStaging(input.operationId)
  updateMoveEndpoint(input.operationId, 'target', { state: 'discarded' })
  sendToMainTargets('workspace:changed')
}

/** Removes this host's staging of a move, unless the host is its source and keeps the package as a backup. */
export async function cleanupMove(input: { operationId: string }): Promise<void> {
  const source = getMoveEndpoint(input.operationId, 'source')
  if (source && source.state !== 'thawed') return
  await removeMoveStaging(input.operationId)
}
