import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExecutionEnvelope } from '@maestrly/protocol'
import type { PreparedEnvironment, ExecutionArtifact } from './executor.js'

export interface ApprovedRepository {
  bindingId: string
  localPath: string
}
export interface RepositoryAvailability {
  bindingId: string
  available: boolean
  branches: string[]
  error?: string
}
export interface WorkspaceOptions {
  retainWorkspace?:boolean

  repositories: ApprovedRepository[]
  baseDirectory?: string
  isolated?: boolean
}
const exec = promisify(execFile)
async function git(args: string[], cwd?: string) {
  return (
    await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      timeout: 30_000,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    })
  ).stdout.trimEnd()
}

export async function inspectRepositories(repositories: ApprovedRepository[]): Promise<RepositoryAvailability[]> {
  return Promise.all(
    repositories.map(async (repository) => {
      try {
        const cwd = path.resolve(repository.localPath)
        await git(['rev-parse', '--git-dir'], cwd)
        const prefix = await git(['rev-parse', '--show-prefix'], cwd)
        if (prefix) throw new Error('Use the repository root.')
        const branches = (await git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'], cwd))
          .split('\n')
          .filter(Boolean)
        if (!branches.length) throw new Error('The repository has no local branches with commits.')
        return { bindingId: repository.bindingId, available: true, branches }
      } catch {
        return {
          bindingId: repository.bindingId,
          available: false,
          branches: [],
          error: 'Repository unavailable or without a committed local branch.',
        }
      }
    })
  )
}

export class WorkspaceManager {
  private readonly repositories: Map<string, string>
  constructor(private readonly options: WorkspaceOptions) {
    this.repositories = new Map(options.repositories.map((r) => [r.bindingId, path.resolve(r.localPath)]))
  }
  async inventory() {
    return inspectRepositories(this.options.repositories)
  }
  async prepare(envelope: ExecutionEnvelope): Promise<PreparedEnvironment> {
    const bindingId = envelope.snapshot.repositoryBindingId
    if(this.options.baseDirectory)await mkdir(this.options.baseDirectory,{recursive:true})
    const root = await mkdtemp(path.join(this.options.baseDirectory ?? os.tmpdir(), `maestrly-${envelope.runId}-`))
    const workspacePath = path.join(root, 'workspace')
    try {
      let gitBaseCommit: string | undefined
      let evidenceGitDirectory: string | undefined
      if (bindingId) {
        const approvedPath = this.repositories.get(bindingId)
        if (!approvedPath) throw new Error('Execution references a repository that is not approved on this runner.')
        const branch = envelope.snapshot.repositoryBranch
        if (!branch) throw new Error('A repository branch is required for this execution.')
        await git(['check-ref-format', '--branch', branch])
        gitBaseCommit = await git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], approvedPath)
        await git(['clone', '--no-hardlinks', '--no-checkout', '--', approvedPath, workspacePath])
        await git(['checkout', '--detach', gitBaseCommit], workspacePath)
        evidenceGitDirectory = path.join(root, 'evidence.git')
        await git(['clone', '--bare', '--no-hardlinks', '--', approvedPath, evidenceGitDirectory])
        // An execution cannot push through the checkout's origin.
        await git(['remote', 'remove', 'origin'], workspacePath)
      } else await mkdir(workspacePath, { recursive: true })
      return {
        workspacePath,
        isolated: this.options.isolated ?? false,
        environment: {},
        runtimeDirectory: path.join(root, 'runtime'),
        gitBaseCommit,
        evidenceGitDirectory,
        repositoryBindingId: bindingId ?? undefined,
        cleanup: () => this.options.retainWorkspace?Promise.resolve():rm(root, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }
}

export async function repositoryEvidence(environment: PreparedEnvironment): Promise<ExecutionArtifact[]> {
  if (!environment.gitBaseCommit) return []
  if (!environment.evidenceGitDirectory) throw new Error('Trusted Git evidence metadata is missing.')
  // Never load Git config/index written by the executor when collecting evidence.
  const options = ['--git-dir=' + environment.evidenceGitDirectory, '--work-tree=' + environment.workspacePath]
  await git([...options, 'read-tree', environment.gitBaseCommit])
  await git([...options, 'add', '--intent-to-add', '--', '.'])
  const patch = await git([
    ...options,
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    environment.gitBaseCommit,
    '--',
    '.',
  ])
  return [
    {
      kind: 'verification',
      name: 'git-base.json',
      contentType: 'application/json',
      bytes: Buffer.from(
        JSON.stringify(
          { repositoryBindingId: environment.repositoryBindingId, baseCommit: environment.gitBaseCommit },
          null,
          2
        )
      ),
    },
    {
      kind: 'patch',
      name: 'delivery.patch',
      contentType: 'text/x-diff',
      bytes: Buffer.from(patch ? patch + '\n' : ''),
    },
  ]
}
