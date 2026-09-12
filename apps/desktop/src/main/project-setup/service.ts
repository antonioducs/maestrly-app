import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, promises as fs, renameSync, rmSync, type Stats } from 'node:fs'
import path from 'node:path'
import type { Workspace } from '../store'
import { getWorkspaceByPath } from '../store'
import { addWorkspace } from '../workspace-service'
import type {
  EmptyRemoteDecision,
  ProjectSetupErrorCode,
  ProjectSetupProgress,
  ProjectSetupRequest,
  ProjectSetupResult,
} from '../../shared/project-setup'
import { isSafeProjectName, validateGitRemoteUrl } from '../../shared/project-setup'
import {
  checkoutCloneDefaultBranch,
  cloneRepository,
  createInitialCommit,
  createReadme,
  forceUnbornHeadToMain,
  forceUnbornHeadToBranch,
  getRepositoryDefaultBranch,
  getRepositoryTopLevel,
  hasUsableHead,
  initializeMainRepository,
  isBareRepository,
  isWorkingTreeRepository,
  preflightGit,
  ProjectSetupGitError,
  validBranch,
} from './git-runner'

export interface ProjectSetupContext {
  signal: AbortSignal
  emit: (progress: Omit<ProjectSetupProgress, 'operationId'>) => void
  markCommitted: () => void
  waitForEmptyRemoteDecision: () => Promise<EmptyRemoteDecision>
}

export interface ProjectSetupServiceDeps {
  addWorkspace: (
    dir: string,
    options?: {
      beforeInsert?: () => void
      validated?: { top: string; defaultBranch: string }
    }
  ) => Promise<Workspace>
  getWorkspaceByPath: (path: string) => Workspace | undefined
}

interface OwnedDirectory {
  destination: string
  parent: ResolvedDirectory
  stat: Pick<Stats, 'dev' | 'ino'>
}

interface ResolvedDirectory {
  path: string
  stat: Pick<Stats, 'dev' | 'ino'>
}

class ProjectSetupFailure extends Error {
  constructor(
    readonly code: ProjectSetupErrorCode,
    readonly canceled = false,
    readonly cleanupUnsafe = false
  ) {
    super(code)
    this.name = 'ProjectSetupFailure'
  }
}

const destinationLocks = new Set<string>()

function throwIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new ProjectSetupFailure('clone-failed', true)
}

async function resolveExistingDirectory(input: string): Promise<ResolvedDirectory> {
  if (!input || input.includes('\0')) throw new ProjectSetupFailure('invalid-path')
  try {
    const real = await fs.realpath(path.resolve(input))
    const stat = await fs.lstat(real)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProjectSetupFailure('invalid-path')
    return { path: real, stat: { dev: stat.dev, ino: stat.ino } }
  } catch (error) {
    if (error instanceof ProjectSetupFailure) throw error
    throw new ProjectSetupFailure('invalid-path')
  }
}

function directoryIdentityMatches(directory: ResolvedDirectory): boolean {
  try {
    const stat = lstatSync(directory.path)
    return (
      stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === directory.stat.dev && stat.ino === directory.stat.ino
    )
  } catch {
    return false
  }
}

function assertDirectoryIdentity(directory: ResolvedDirectory, cleanupUnsafe = false): void {
  if (!directoryIdentityMatches(directory)) throw new ProjectSetupFailure('invalid-path', false, cleanupUnsafe)
}

function assertOwnedIdentity(owned: OwnedDirectory): void {
  assertDirectoryIdentity(owned.parent, true)
  if (!directoryIdentityMatches({ path: owned.destination, stat: owned.stat })) {
    throw new ProjectSetupFailure('invalid-path', false, true)
  }
}

function resultError(code: ProjectSetupErrorCode, cleanupIncomplete = false): ProjectSetupResult<Workspace> {
  return {
    status: 'error',
    error: {
      code: cleanupIncomplete ? 'cleanup-incomplete' : code,
      ...(cleanupIncomplete ? { cleanupIncomplete: true } : {}),
    },
  }
}

function createOwnedDestination(parent: ResolvedDirectory, destination: string): OwnedDirectory {
  assertDirectoryIdentity(parent)
  let created = false
  try {
    // Synchronously reserve without clobbering and capture identity between mkdir/lstat. Revalidate before
    // effects to cover external processes.
    mkdirSync(destination)
    created = true
    const stat = lstatSync(destination)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProjectSetupFailure('invalid-path', false, true)
    }
    assertDirectoryIdentity(parent, true)
    return { destination, parent, stat: { dev: stat.dev, ino: stat.ino } }
  } catch (error) {
    if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProjectSetupFailure('destination-exists')
    }
    if (error instanceof ProjectSetupFailure && error.cleanupUnsafe) throw error
    throw new ProjectSetupFailure('invalid-path', false, created)
  }
}

function removeQuarantinedDirectory(quarantine: string, expected: Pick<Stats, 'dev' | 'ino'>): boolean {
  const stat = lstatSync(quarantine)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    return false
  }
  // Rename, validation, and traversal begin without yielding. Git has stopped and the root is no longer at
  // its known name; rmSync removes internal symlinks as links.
  rmSync(quarantine, { recursive: true, force: false })
  return true
}

function cleanupOwnedDirectory(owned: OwnedDirectory): boolean {
  let quarantine: string | undefined
  try {
    assertDirectoryIdentity(owned.parent)
    const expected = path.join(owned.parent.path, path.basename(owned.destination))
    if (path.resolve(owned.destination) !== expected) return false
    const stat = lstatSync(owned.destination)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owned.stat.dev || stat.ino !== owned.stat.ino) {
      return false
    }
    // Move the owned directory to unpredictable quarantine before recursive deletion so later replacement
    // of its original path cannot become the removal target.
    quarantine = path.join(owned.parent.path, `.maestrly-cleanup-${randomUUID()}`)
    renameSync(owned.destination, quarantine)
    if (!removeQuarantinedDirectory(quarantine, owned.stat)) {
      // If another process replaced the entry between lstat and rename, neither delete nor restore with
      // overwriting rename. Report incomplete cleanup for manual inspection.
      return false
    }
    return true
  } catch {
    // Absence at the expected name does not prove deletion; another process may have moved the owned root.
    return false
  }
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function resolveRepositoryRoot(
  dir: string,
  selected: ResolvedDirectory,
  signal: AbortSignal | undefined
): Promise<ResolvedDirectory | null> {
  const top = await getRepositoryTopLevel(dir, signal)
  if (!top) return null
  const root = await resolveExistingDirectory(top)
  if (!isInsideDirectory(root.path, selected.path)) throw new ProjectSetupFailure('invalid-path')
  assertDirectoryIdentity(selected)
  assertDirectoryIdentity(root)
  return root
}

async function registerReadyRepository(
  directory: ResolvedDirectory,
  ctx: ProjectSetupContext,
  deps: ProjectSetupServiceDeps,
  committed = false
): Promise<ProjectSetupResult<Workspace>> {
  const dir = directory.path
  if (!committed) throwIfCanceled(ctx.signal)
  assertDirectoryIdentity(directory)
  const signal = committed ? undefined : ctx.signal
  if (await isBareRepository(dir, signal)) throw new ProjectSetupFailure('bare-repository')
  if (!(await isWorkingTreeRepository(dir, signal))) throw new ProjectSetupFailure('not-git-repository')
  if (!(await hasUsableHead(dir, signal))) throw new ProjectSetupFailure('initial-commit-failed')
  const root = await resolveRepositoryRoot(dir, directory, signal)
  if (!root) throw new ProjectSetupFailure('not-git-repository')
  const existing = deps.getWorkspaceByPath(root.path)
  const defaultBranch = await getRepositoryDefaultBranch(root.path, signal)
  if (!committed) throwIfCanceled(ctx.signal)
  ctx.emit({ phase: 'registering' })
  let workspace: Workspace
  try {
    workspace = await deps.addWorkspace(dir, {
      validated: { top: root.path, defaultBranch },
      beforeInsert: () => {
        if (!directoryIdentityMatches(directory) || !directoryIdentityMatches(root)) {
          throw new ProjectSetupFailure('invalid-path')
        }
        if (!committed) throwIfCanceled(ctx.signal)
      },
    })
  } catch (error) {
    if (error instanceof ProjectSetupFailure) throw error
    throw new ProjectSetupFailure('registration-failed')
  }
  // After persistence, cancellation cannot truthfully report no changes. Finish registration or report
  // errors; progress delivery is best-effort.
  ctx.emit({ phase: 'completed', percent: 100 })
  return { status: 'success', workspace, reused: existing?.id === workspace.id }
}

function acquireDestinationLock(destination: string): void {
  if (destinationLocks.has(destination)) throw new ProjectSetupFailure('operation-conflict')
  destinationLocks.add(destination)
}

export function createProjectSetupService(overrides: Partial<ProjectSetupServiceDeps> = {}): {
  execute: (request: ProjectSetupRequest, ctx: ProjectSetupContext) => Promise<ProjectSetupResult<Workspace>>
} {
  const deps: ProjectSetupServiceDeps = {
    addWorkspace,
    getWorkspaceByPath,
    ...overrides,
  }

  return {
    async execute(request, ctx) {
      let owned: OwnedDirectory | undefined
      let shouldCleanup = false
      let committed = false
      let lockedDestination: string | undefined
      try {
        ctx.emit({ phase: 'validating' })
        throwIfCanceled(ctx.signal)

        if (request.kind === 'open') {
          const selected = await resolveExistingDirectory(request.path)
          const dir = selected.path
          throwIfCanceled(ctx.signal)
          assertDirectoryIdentity(selected)
          const root = await resolveRepositoryRoot(dir, selected, ctx.signal)
          const existing = root ? deps.getWorkspaceByPath(root.path) : undefined
          throwIfCanceled(ctx.signal)
          if (existing && root) {
            assertDirectoryIdentity(selected)
            assertDirectoryIdentity(root)
            ctx.emit({ phase: 'completed', percent: 100 })
            return { status: 'success', workspace: existing, reused: true }
          }
          if (await isBareRepository(dir, ctx.signal)) throw new ProjectSetupFailure('bare-repository')
          throwIfCanceled(ctx.signal)
          if (!(await isWorkingTreeRepository(dir, ctx.signal))) {
            throwIfCanceled(ctx.signal)
            return { status: 'needs-initialization', path: dir }
          }
          if (!(await hasUsableHead(dir, ctx.signal))) {
            throwIfCanceled(ctx.signal)
            return { status: 'needs-initialization', path: dir }
          }
          return await registerReadyRepository(selected, ctx, deps)
        }

        if (request.kind === 'initialize-existing') {
          const selected = await resolveExistingDirectory(request.path)
          const dir = selected.path
          throwIfCanceled(ctx.signal)
          assertDirectoryIdentity(selected)
          const root = await resolveRepositoryRoot(dir, selected, ctx.signal)
          const existing = root ? deps.getWorkspaceByPath(root.path) : undefined
          throwIfCanceled(ctx.signal)
          if (existing && root) {
            assertDirectoryIdentity(selected)
            assertDirectoryIdentity(root)
            ctx.emit({ phase: 'completed', percent: 100 })
            return { status: 'success', workspace: existing, reused: true }
          }
          await preflightGit(dir, ctx.signal)
          assertDirectoryIdentity(selected)
          if (await isBareRepository(dir, ctx.signal)) throw new ProjectSetupFailure('bare-repository')
          const isRepository = await isWorkingTreeRepository(dir, ctx.signal)
          const hasHead = isRepository ? await hasUsableHead(dir, ctx.signal) : false
          if (!hasHead) {
            // The first mutation in a user's directory is the commit point because .git remains on failure.
            // Afterward finish registration or report errors, never canceled as if nothing changed.
            throwIfCanceled(ctx.signal)
            assertDirectoryIdentity(selected)
            committed = true
            ctx.markCommitted()
            if (!isRepository) {
              ctx.emit({ phase: 'initializing-git' })
              await initializeMainRepository(dir)
            }
            await forceUnbornHeadToMain(dir)
            ctx.emit({ phase: 'creating-initial-commit' })
            await createInitialCommit(dir, { includeReadme: false })
          }
          return await registerReadyRepository(selected, ctx, deps, committed)
        }

        const parent = await resolveExistingDirectory(request.parentPath)
        if (!isSafeProjectName(request.name)) throw new ProjectSetupFailure('invalid-name')
        if (request.kind === 'clone') {
          const remoteValidation = validateGitRemoteUrl(request.remoteUrl)
          if (!remoteValidation.valid) throw new ProjectSetupFailure(remoteValidation.code)
        }
        const name = request.name.trim()
        const destination = path.join(parent.path, name)
        if (path.dirname(destination) !== parent.path) throw new ProjectSetupFailure('invalid-name')

        // Hold the lock through execute's finally, including failure cleanup, so no competing operation
        // acquires the destination during removal/quarantine.
        acquireDestinationLock(destination)
        lockedDestination = destination

        await preflightGit(parent.path, ctx.signal)
        if (request.kind === 'clone' && request.defaultBranch) {
          if (!(await validBranch(parent.path, request.defaultBranch, ctx.signal))) {
            throw new ProjectSetupFailure('invalid-request')
          }
        }
        throwIfCanceled(ctx.signal)
        ctx.emit({ phase: 'preparing' })
        owned = createOwnedDestination(parent, destination)
        shouldCleanup = true

        if (request.kind === 'create') {
          assertOwnedIdentity(owned)
          ctx.emit({ phase: 'initializing-git' })
          await initializeMainRepository(owned.destination, ctx.signal)
          assertOwnedIdentity(owned)
          ctx.emit({ phase: 'creating-readme' })
          await createReadme(owned.destination, name)
          assertOwnedIdentity(owned)
          ctx.emit({ phase: 'creating-initial-commit' })
          await createInitialCommit(owned.destination, { includeReadme: true, signal: ctx.signal })
          assertOwnedIdentity(owned)
          throwIfCanceled(ctx.signal)
          // The final directory is the atomic owned reservation. Once ready, finish registration even if UI
          // closes to avoid canceled results with orphan repositories.
          shouldCleanup = false
          committed = true
          ctx.markCommitted()
          return await registerReadyRepository({ path: owned.destination, stat: owned.stat }, ctx, deps, true)
        }

        assertOwnedIdentity(owned)
        await cloneRepository({
          parentPath: parent.path,
          remoteUrl: request.remoteUrl.trim(),
          destination: owned.destination,
          signal: ctx.signal,
          onProgress: ctx.emit,
        })
        assertOwnedIdentity(owned)
        throwIfCanceled(ctx.signal)
        const hasHead = await hasUsableHead(owned.destination, ctx.signal)
        if (hasHead && request.defaultBranch) {
          await checkoutCloneDefaultBranch(owned.destination, request.defaultBranch, ctx.signal)
        }
        if (!hasHead) {
          ctx.emit({ phase: 'awaiting-empty-remote-confirmation' })
          const decision = await ctx.waitForEmptyRemoteDecision()
          throwIfCanceled(ctx.signal)
          if (decision !== 'initialize-local') throw new ProjectSetupFailure('clone-failed', true)
          assertOwnedIdentity(owned)
          ctx.emit({ phase: 'initializing-git' })
          await forceUnbornHeadToBranch(owned.destination, request.defaultBranch?.trim() || 'main', ctx.signal)
          assertOwnedIdentity(owned)
          ctx.emit({ phase: 'creating-readme' })
          await createReadme(owned.destination, name)
          assertOwnedIdentity(owned)
          ctx.emit({ phase: 'creating-initial-commit' })
          await createInitialCommit(owned.destination, { includeReadme: true, signal: ctx.signal })
        }
        assertOwnedIdentity(owned)
        throwIfCanceled(ctx.signal)
        shouldCleanup = false
        committed = true
        ctx.markCommitted()
        return await registerReadyRepository({ path: owned.destination, stat: owned.stat }, ctx, deps, true)
      } catch (error) {
        const gitFailure = error instanceof ProjectSetupGitError ? error : undefined
        const failure =
          error instanceof ProjectSetupFailure
            ? error
            : gitFailure
              ? new ProjectSetupFailure(gitFailure.code, gitFailure.canceled)
              : new ProjectSetupFailure(request.kind === 'clone' ? 'clone-failed' : 'initialization-failed')
        if (failure.cleanupUnsafe) {
          if (shouldCleanup) ctx.emit({ phase: 'cleaning-up' })
          return resultError(failure.code, true)
        }
        if (shouldCleanup && gitFailure?.cleanupUnsafe) {
          ctx.emit({ phase: 'cleaning-up' })
          return resultError(failure.code, true)
        }
        if (shouldCleanup && owned) {
          ctx.emit({ phase: 'cleaning-up' })
          const cleaned = cleanupOwnedDirectory(owned)
          if (!cleaned) return resultError(failure.code, true)
        }
        return !committed && (failure.canceled || ctx.signal.aborted)
          ? { status: 'canceled' }
          : resultError(failure.code)
      } finally {
        if (lockedDestination) destinationLocks.delete(lockedDestination)
      }
    },
  }
}

export const projectSetupService = createProjectSetupService()
