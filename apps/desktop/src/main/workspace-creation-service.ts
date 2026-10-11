import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Conversation } from '../shared/conversation'
import { getWorkspace, type Workspace } from './store'
import {
  isSafeProjectName,
  suggestProjectName,
  validateGitRemoteUrl,
  type ProjectSetupErrorCode,
  type ProjectSetupRequest,
  type ProjectSetupResult,
} from '../shared/project-setup'
import {
  createWorkspaceInputSchema,
  requestedGithubRepository,
  sameGitRemote,
  type CreateWorkspaceInput,
  type GithubRepositoryOption,
  type WorkspaceCreationErrorCode,
  type WorkspaceCreationProgress,
  type WorkspaceCreationRemoteStatus,
  type WorkspaceCreationResult,
  type WorkspaceCreationSource,
  WORKSPACE_CREATION_MAX_PER_TURN,
} from '../shared/workspace-creation'
import {
  beginWorkspaceCreation,
  completeWorkspaceCreation,
  failWorkspaceCreation,
  findWorkspaceCreation,
  listRegisteredWorkspaceCreationIds,
  listWorkspaceCreationRequestKeys,
  type WorkspaceCreationRecord,
} from './workspace-creation-store'
import type { HumanTurnGrant } from './chat/conversation-dispatch-authorization'
import type { ProjectSetupContext } from './project-setup/service'
import { getOriginUrl, getRepositoryTopLevel } from './project-setup/git-runner'

/**
 * Creates or clones a project into the configured projects folder from a chat turn and registers it as a
 * workspace, so the agent can start conversations in it. The agent judges from the conversation that the person
 * asked for it; the host requires a live turn the person started and asks them before anything becomes public.
 * Every attempt is journaled so a repeated call replays the registered workspace instead of cloning again. A folder
 * that already exists is reused only when it is a clone of the same remote; anything else is left untouched.
 */

export interface WorkspaceCreationServiceDeps {
  getConversation(id: string): Conversation | undefined
  isWebManaged(conversationId: string): boolean
  getProjectsDirectory(): string | null
  getWorkspace(id: string): Workspace | undefined
  getWorkspaceByPath(path: string): Workspace | undefined
  executeSetup(request: ProjectSetupRequest, ctx: ProjectSetupContext): Promise<ProjectSetupResult<Workspace>>
  /** Origin URL when `dir` is itself the top level of a git working tree; null otherwise. */
  readRepositoryOrigin(dir: string, signal: AbortSignal): Promise<string | null>
  github: {
    cloneUrl(repo: string, signal: AbortSignal): Promise<string>
    preflight(signal: AbortSignal): Promise<void>
    create(
      input: { dir: string; name: string; owner?: string; visibility: 'private' | 'public' },
      signal: AbortSignal
    ): Promise<{ url: string }>
    errorMessage(error: unknown): string
  }
  emitProgress(progress: WorkspaceCreationProgress): void
  notifyWorkspacesChanged(): void
}

interface CreateInput {
  grant: HumanTurnGrant
  input: CreateWorkspaceInput
  signal: AbortSignal
  /** Rechecked right before the first effect: the authorizing turn must still be live. */
  assertCurrent: () => void
  /** Asks the person before a public GitHub repository is created; absent means it is never created. */
  confirmPublic?: (repo: string) => Promise<'public' | 'private' | 'cancel'>
}

class CreationFailure extends Error {
  constructor(
    readonly code: WorkspaceCreationErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CreationFailure'
  }
}

const SETUP_MESSAGES: Partial<Record<ProjectSetupErrorCode, [WorkspaceCreationErrorCode, string]>> = {
  'git-not-found': ['setup-failed', 'Git is not installed or not on PATH.'],
  'git-incompatible': ['setup-failed', 'The installed Git version is not supported.'],
  'invalid-url': ['invalid-request', 'The clone URL is not valid.'],
  'embedded-credentials': ['invalid-request', 'Clone URLs must not contain credentials.'],
  'invalid-name': ['invalid-request', 'The project name is not a valid folder name.'],
  'invalid-path': ['projects-directory-missing', 'The projects folder is not accessible.'],
  'destination-exists': ['destination-exists', 'A folder with this name already exists in the projects folder.'],
  'clone-authentication-failed': [
    'setup-failed',
    'Git could not authenticate to the repository. For GitHub, the person can run "gh auth login" and "gh auth setup-git".',
  ],
  'clone-network-failed': ['setup-failed', 'The repository host could not be reached.'],
  'remote-not-found': [
    'setup-failed',
    'The repository was not found or is not accessible with the current credentials.',
  ],
  'operation-conflict': ['setup-failed', 'Another operation is creating a project in the same folder.'],
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fingerprintOf(input: CreateWorkspaceInput): string {
  const { source } = input
  const github = requestedGithubRepository(source)
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.name ?? null,
        source.kind,
        source.repo?.toLowerCase() ?? null,
        source.url ?? null,
        github ? [github.owner ?? null, github.visibility ?? 'private'] : null,
      ])
    )
    .digest('hex')
}

function sourceLabel(source: WorkspaceCreationSource, name: string): string {
  if (source.kind === 'github') return source.repo ?? name
  if (source.kind === 'git') return source.url ?? name
  return name
}

export function createWorkspaceCreationService(deps: WorkspaceCreationServiceDeps) {
  const inflight = new Map<string, Promise<unknown>>()

  function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = inflight.get(key)
    const work = previous ? previous.then(operation, operation) : operation()
    const tail = work.catch(() => undefined)
    inflight.set(key, tail)
    void tail.then(() => {
      if (inflight.get(key) === tail) inflight.delete(key)
    })
    return work
  }

  function failure(code: WorkspaceCreationErrorCode, error: string, requestKey?: string): WorkspaceCreationResult {
    return { ok: false, code, error, ...(requestKey ? { requestKey } : {}) }
  }

  function resultFromRecord(record: WorkspaceCreationRecord, replayed: boolean): WorkspaceCreationResult {
    const workspace = record.workspaceId ? deps.getWorkspace(record.workspaceId) : undefined
    if (!workspace)
      return failure(
        'workspace-removed',
        `The workspace created for "${record.requestKey}" was removed; it is not recreated by a retry.`,
        record.requestKey
      )
    return {
      ok: true,
      requestKey: record.requestKey,
      source: { kind: record.source.kind, label: sourceLabel(record.source, record.name) },
      workspaceId: workspace.id,
      name: workspace.name,
      path: workspace.path,
      defaultBranch: workspace.defaultBranch,
      ...(record.remoteUrl ? { remoteUrl: record.remoteUrl } : {}),
      reused: record.reused,
      ...(replayed ? { replayed: true } : {}),
      ...(record.remote ? { remote: record.remote } : {}),
    }
  }

  async function projectsFolder(): Promise<string> {
    const configured = deps.getProjectsDirectory()
    if (!configured)
      throw new CreationFailure(
        'projects-directory-not-set',
        'No projects folder is configured. Ask the person to set it with the "Set projects folder" button in this ' +
          'card (or in Settings › Execution), then call create_workspace again with the same requestKey once they have.'
      )
    try {
      const real = await fs.realpath(configured)
      if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory')
      return real
    } catch {
      throw new CreationFailure(
        'projects-directory-missing',
        `The projects folder "${configured}" is not accessible. Ask the person to choose another one.`
      )
    }
  }

  async function resolveRemote(source: WorkspaceCreationSource, signal: AbortSignal): Promise<string | null> {
    if (source.kind === 'github') {
      // gh knows the person's preferred protocol; without it, the public HTTPS URL still clones what git can reach.
      return deps.github.cloneUrl(source.repo!, signal).catch(() => `https://github.com/${source.repo}.git`)
    }
    if (source.kind === 'git') {
      const validation = validateGitRemoteUrl(source.url!)
      if (!validation.valid)
        throw new CreationFailure(
          'invalid-request',
          validation.code === 'embedded-credentials'
            ? 'Clone URLs must not contain credentials, query strings or fragments.'
            : 'The clone URL is not valid.'
        )
      return source.url!.trim()
    }
    return null
  }

  function setupFailure(result: Exclude<ProjectSetupResult<Workspace>, { status: 'success' }>, destination: string) {
    if (result.status === 'canceled')
      return new CreationFailure('cancelled', 'The request was cancelled; nothing was kept.')
    if (result.status === 'needs-initialization')
      return new CreationFailure(
        'destination-exists',
        `"${destination}" exists and is not a git repository; it was left untouched.`
      )
    if (result.error.cleanupIncomplete)
      return new CreationFailure(
        'setup-failed',
        `Project setup failed and the partial folder "${destination}" could not be removed safely; ask the person to inspect it.`
      )
    const [code, message] = SETUP_MESSAGES[result.error.code] ?? [
      'setup-failed',
      `Project setup failed (${result.error.code}).`,
    ]
    return new CreationFailure(code, message)
  }

  /** Register what already sits at the destination when it is a clone of the same remote; never touch anything else. */
  async function adoptExisting(
    destination: string,
    remoteUrl: string | null,
    label: string,
    ctx: ProjectSetupContext
  ): Promise<Workspace> {
    const untouched = `"${destination}" already exists and is not a clone of ${label}; it was left untouched. Choose another name.`
    if (!remoteUrl) throw new CreationFailure('destination-exists', untouched)
    const real = await fs.realpath(destination).catch(() => null)
    const origin = real ? await deps.readRepositoryOrigin(real, ctx.signal).catch(() => null) : null
    if (!real || !origin || !sameGitRemote(origin, remoteUrl))
      throw new CreationFailure('destination-exists', untouched)
    const registered = deps.getWorkspaceByPath(real)
    if (registered) return registered
    const result = await deps.executeSetup({ operationId: randomUUID(), kind: 'open', path: real }, ctx)
    if (result.status !== 'success') throw setupFailure(result, destination)
    return result.workspace
  }

  async function createOnce(input: CreateInput): Promise<WorkspaceCreationResult> {
    const { grant, signal } = input
    const request = input.input
    const sourceId = grant.conversationId
    const source = deps.getConversation(sourceId)
    if (!source) return failure('source-unsupported', 'The source conversation no longer exists.', request.requestKey)
    if (source.botOrigin)
      return failure('source-unsupported', 'Bot conversations cannot create projects.', request.requestKey)
    if (deps.isWebManaged(sourceId))
      return failure('source-unsupported', 'This conversation is managed in the Kanban web chat.', request.requestKey)
    const github = requestedGithubRepository(request.source)

    const fingerprint = fingerprintOf(request)
    const existing = findWorkspaceCreation(sourceId, grant.originKey, request.requestKey)
    if (existing && existing.fingerprint !== fingerprint)
      return failure(
        'request-conflict',
        `Request "${request.requestKey}" was already used for a different project; use a new request key.`,
        request.requestKey
      )
    if (existing?.phase === 'registered') return resultFromRecord(existing, true)

    const keys = new Set(listWorkspaceCreationRequestKeys(sourceId, grant.originKey))
    keys.add(request.requestKey)
    if (keys.size > WORKSPACE_CREATION_MAX_PER_TURN)
      return failure(
        'count-exceeded',
        `At most ${WORKSPACE_CREATION_MAX_PER_TURN} projects can be created per message; ask the person to continue in a new message.`,
        request.requestKey
      )

    let record: WorkspaceCreationRecord | null = null
    try {
      const parent = await projectsFolder()
      const remoteUrl = await resolveRemote(request.source, signal)
      const name = (request.name ?? suggestProjectName(request.source.repo ?? remoteUrl ?? '')).trim()
      if (!isSafeProjectName(name))
        throw new CreationFailure('invalid-request', `"${name}" is not a valid folder name; pass another name.`)
      let visibility: 'private' | 'public' = github?.visibility ?? 'private'
      if (github) {
        try {
          await deps.github.preflight(signal)
        } catch (error) {
          throw new CreationFailure('github-unavailable', deps.github.errorMessage(error))
        }
        // Publishing cannot be taken back, so the person confirms it even when the agent understood it right.
        if (visibility === 'public') {
          const choice = input.confirmPublic
            ? await input.confirmPublic(github.owner ? `${github.owner}/${name}` : name)
            : 'cancel'
          if (choice === 'cancel')
            throw new CreationFailure(
              'not-confirmed',
              'The person did not confirm a public GitHub repository; nothing was created. Ask whether a private one is fine.'
            )
          visibility = choice
        }
      }
      const destination = path.join(parent, name)
      const label = sourceLabel(request.source, name)
      try {
        input.assertCurrent()
      } catch (error) {
        throw new CreationFailure('cancelled', errorText(error))
      }
      if (signal.aborted) throw new CreationFailure('cancelled', 'The request was cancelled before it started.')

      // Inside the per-key queue nothing else is creating this request: a leftover `creating` record is a crash.
      if (existing?.phase === 'creating') failWorkspaceCreation(existing.creationId, 'Interrupted before registration.')
      let begun: ReturnType<typeof beginWorkspaceCreation>
      try {
        begun = beginWorkspaceCreation({
          creationId: randomUUID(),
          sourceConversationId: sourceId,
          originKey: grant.originKey,
          requestKey: request.requestKey,
          fingerprint,
          source: request.source,
          name,
          destination,
          remoteUrl,
        })
      } catch (error) {
        throw new CreationFailure('persistence-failed', `Could not record the request: ${errorText(error)}`)
      }
      if (!begun.started) return resultFromRecord(begun.record, true)
      record = begun.record

      const ctx: ProjectSetupContext = {
        signal,
        emit: (progress) =>
          deps.emitProgress({
            conversationId: sourceId,
            requestKey: request.requestKey,
            phase: progress.phase,
            ...(progress.percent === undefined ? {} : { percent: progress.percent }),
            path: destination,
          }),
        markCommitted: () => {},
        // The person explicitly asked for this project: an empty remote starts as a new local project.
        waitForEmptyRemoteDecision: async () => 'initialize-local',
      }
      const exists = await fs.lstat(destination).then(
        () => true,
        () => false
      )
      let workspace: Workspace
      let reused = false
      if (exists) {
        workspace = await adoptExisting(destination, remoteUrl, label, ctx)
        reused = true
      } else {
        const setup = await deps.executeSetup(
          remoteUrl
            ? { operationId: randomUUID(), kind: 'clone', parentPath: parent, name, remoteUrl }
            : { operationId: randomUUID(), kind: 'create', parentPath: parent, name },
          ctx
        )
        if (setup.status !== 'success') throw setupFailure(setup, destination)
        workspace = setup.workspace
        reused = setup.reused
      }

      // The local workspace is registered from here on; a GitHub failure is reported without undoing it.
      let remote: WorkspaceCreationRemoteStatus | null = null
      let finalRemote = remoteUrl
      if (github) {
        deps.emitProgress({
          conversationId: sourceId,
          requestKey: request.requestKey,
          phase: 'creating-remote',
          path: workspace.path,
        })
        try {
          if (signal.aborted) throw new Error('The request was cancelled before the GitHub repository was created.')
          const created = await deps.github.create(
            {
              dir: workspace.path,
              name,
              ...(github.owner ? { owner: github.owner } : {}),
              visibility,
            },
            signal
          )
          remote = { status: 'created', url: created.url }
          finalRemote = created.url
        } catch (error) {
          remote = { status: 'failed', error: deps.github.errorMessage(error) }
        }
      }
      completeWorkspaceCreation(record.creationId, {
        workspaceId: workspace.id,
        destination: workspace.path,
        reused,
        remoteUrl: finalRemote,
        remote,
      })
      deps.notifyWorkspacesChanged()
      deps.emitProgress({
        conversationId: sourceId,
        requestKey: request.requestKey,
        phase: 'completed',
        percent: 100,
        path: workspace.path,
      })
      return resultFromRecord(findWorkspaceCreation(sourceId, grant.originKey, request.requestKey)!, false)
    } catch (error) {
      const known =
        error instanceof CreationFailure
          ? error
          : new CreationFailure('setup-failed', `Project setup failed: ${errorText(error)}`)
      if (record) failWorkspaceCreation(record.creationId, known.message)
      return failure(known.code, known.message, request.requestKey)
    }
  }

  /** Create (or replay) one project for the grant's turn. */
  function create(input: Omit<CreateInput, 'input'> & { input: unknown }): Promise<WorkspaceCreationResult> {
    const parsed = createWorkspaceInputSchema.safeParse(input.input)
    if (!parsed.success) return Promise.resolve(failure('invalid-request', parsed.error.message))
    const key = JSON.stringify([input.grant.conversationId, input.grant.originKey, parsed.data.requestKey])
    return serialized(key, () => createOnce({ ...input, input: parsed.data }))
  }

  return { create }
}

export type WorkspaceCreationService = ReturnType<typeof createWorkspaceCreationService>

// ---------------------------------------------------------------------------------------------------------------
// Production wiring, loaded lazily from the chat tools (static imports of the chat service would form a cycle).
// ---------------------------------------------------------------------------------------------------------------

/** Origin of `dir` only when `dir` is itself a repository top level: a folder inside another repository has none. */
export async function readRepositoryOrigin(dir: string, signal: AbortSignal): Promise<string | null> {
  const top = await getRepositoryTopLevel(dir, signal)
  if (!top || (await fs.realpath(top)) !== (await fs.realpath(dir))) return null
  return getOriginUrl(dir, signal)
}

async function buildDefaultWorkspaceCreationService(): Promise<WorkspaceCreationService> {
  const [store, remotePolicy, setup, projects, github, windowIpc] = await Promise.all([
    import('./store'),
    import('./chat/remote-policy'),
    import('./project-setup/service'),
    import('./projects-directory'),
    import('./github-repositories'),
    import('./window-ipc'),
  ])
  const repositories = github.createGithubRepositories()
  return createWorkspaceCreationService({
    getConversation: (id) => store.getConversation(id),
    isWebManaged: remotePolicy.isWebManagedConversation,
    getProjectsDirectory: projects.getProjectsDirectory,
    getWorkspace: store.getWorkspace,
    getWorkspaceByPath: store.getWorkspaceByPath,
    executeSetup: (request, ctx) => setup.projectSetupService.execute(request, ctx),
    readRepositoryOrigin,
    github: {
      cloneUrl: repositories.cloneUrl,
      preflight: repositories.preflight,
      create: repositories.create,
      errorMessage: github.githubErrorMessage,
    },
    emitProgress: (progress) => windowIpc.broadcast('workspace-creation:progress', progress),
    notifyWorkspacesChanged: () => windowIpc.broadcast('workspace:changed'),
  })
}

let defaultService: Promise<WorkspaceCreationService> | null = null

export function getWorkspaceCreationService(): Promise<WorkspaceCreationService> {
  defaultService ??= buildDefaultWorkspaceCreationService().catch((error) => {
    defaultService = null
    throw error
  })
  return defaultService
}

/**
 * Workspaces created (or replayed) by create_workspace under this turn that are still registered. Starting a
 * conversation in one of them needs no separate request: working in it is why it was created.
 */
export function createdWorkspaceIdsForTurn(sourceConversationId: string, originKey: string): string[] {
  return listRegisteredWorkspaceCreationIds(sourceConversationId, originKey).filter((id) => getWorkspace(id))
}

/** Read-only GitHub discovery for find_github_repositories. */
export async function findGithubRepositoriesForChat(
  input: { query?: string; owner?: string },
  signal: AbortSignal
): Promise<{ repositories: GithubRepositoryOption[] } | { error: string }> {
  const github = await import('./github-repositories')
  try {
    return { repositories: await github.createGithubRepositories().find(input, signal) }
  } catch (error) {
    return { error: github.githubErrorMessage(error) }
  }
}
