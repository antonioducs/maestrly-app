/**
 * Builds the delegation inventory this computer advertises: the exact account/model selections, the
 * capabilities the host can actually perform (named checks, GitHub, preview, browser) and a deterministic
 * revision the server records in a stage snapshot.
 *
 * The mapping from an opaque `selectionId` back to a provider account and model never leaves this process.
 */
import {
  DELEGATION_STAGE_CAPABILITY,
  delegationModelCatalogSchema,
  delegationCatalogRevision,
  type DelegationCheckDescriptor,
  type DelegationFeatures,
  type DelegationModelCatalog,
  type DelegationModelEntry,
  type DelegationWorkspace,
} from '@maestrly/protocol'
import { inspectRepositories } from '@maestrly/runner-core'
import { getWorkspace } from '../store'
import { listAgents } from '../chat/agents'
import { runGhCommand } from '../gh-command'
import type { PlatformProjectBinding } from '../../shared/platform'
import type { DesktopExecutorSettings } from './executor-settings'
import type { DesktopModelCatalog, LocalModelSelection } from './desktop-executor'

export interface DelegationCatalogProbes {
  /** Named project checks the host can run; configured per workspace. */
  checks(workspacePaths: string[]): Promise<DelegationCheckDescriptor[]>
  /** GitHub CLI login as observed on this computer. Credentials never leave the executor. */
  github(cwd: string | null): Promise<{ available: boolean; login: string | null; issue: string | null }>
  /** Subagent profiles available in the bound workspaces. */
  profiles(workspacePaths: string[]): Promise<string[]>
}

async function ghLogin(cwd: string | null) {
  if (!cwd) return { available: false, login: null, issue: 'No bound workspace to resolve a GitHub login from.' }
  try {
    const output = await runGhCommand(cwd, ['auth', 'status', '--active'], { timeoutMs: 8_000 })
    const login = /account\s+([A-Za-z0-9-]+)/.exec(output)?.[1] ?? null
    return { available: true, login, issue: null }
  } catch (error) {
    const kind = (error as { kind?: string }).kind
    return {
      available: false,
      login: null,
      issue:
        kind === 'no-gh'
          ? 'Install the GitHub CLI to open and follow pull requests from this computer.'
          : 'Sign in with `gh auth login` to open and follow pull requests from this computer.',
    }
  }
}

export const defaultDelegationProbes: DelegationCatalogProbes = {
  checks: async () => [],
  github: ghLogin,
  profiles: async (paths) => {
    const names = new Set<string>()
    for (const path of paths) for (const agent of await listAgents(path)) names.add(agent.name)
    return [...names].sort()
  },
}

export interface DelegationCatalogInput {
  catalog: Pick<DesktopModelCatalog, 'selections'>
  settings: DesktopExecutorSettings
  bindings: PlatformProjectBinding[]
  probes?: Partial<DelegationCatalogProbes>
  /** Injected in tests so the inventory stays deterministic. */
  now?: () => Date
  workspacePathFor?: (workspaceId: string) => string | null
  inspect?: typeof inspectRepositories
  harnessIdentity?: (selection: LocalModelSelection) => { profileId: string | null; hash: string | null }
}

function workspaceKey(binding: PlatformProjectBinding) {
  return binding.connectionId + ':' + binding.projectId + ':' + binding.workspaceId
}

export async function buildDelegationCatalog(input: DelegationCatalogInput): Promise<DelegationModelCatalog> {
  const probes = { ...defaultDelegationProbes, ...input.probes }
  const resolvePath = input.workspacePathFor ?? ((id: string) => getWorkspace(id)?.path ?? null)
  const inspect = input.inspect ?? inspectRepositories
  const workspaces: DelegationWorkspace[] = []
  const paths: string[] = []
  for (const binding of input.bindings) {
    const path = resolvePath(binding.workspaceId)
    if (!path) continue
    const key = workspaceKey(binding)
    const [repository] = await inspect([{ bindingId: key, localPath: path }])
    if (!repository?.available) continue
    paths.push(path)
    workspaces.push({
      projectId: binding.projectId,
      key,
      label: binding.projectId,
      branches: repository.branches,
      repositoryBindingId: binding.repositoryBindingId ?? null,
    })
  }
  const profiles = input.settings.allowAppTools ? await probes.profiles(paths) : []
  const github = await probes.github(paths[0] ?? null)
  const features: DelegationFeatures = {
    checks: input.settings.allowCommands ? await probes.checks(paths) : [],
    github,
    preview: input.settings.allowCommands
      ? { available: true, issue: null }
      : { available: false, issue: 'Enable commands on this executor to start a preview.' },
    maestro: true,
    subagents: profiles.length > 0,
    browserInspect: input.settings.allowWeb,
    browserInteract: input.settings.allowWeb && input.settings.allowAppTools,
  }
  const models: DelegationModelEntry[] = (await input.catalog.selections()).map((selection) => {
    const harness = input.harnessIdentity?.(selection) ?? { profileId: null, hash: null }
    return {
      selectionId: selection.selectionId,
      modelLabel: selection.modelId,
      accountLabel: selection.providerLabel,
      efforts: [...selection.reasoningEfforts],
      fastMode: selection.fastMode,
      executionModes: ['standard', 'maestro'],
      delegationProfiles: profiles,
      harnessProfileId: harness.profileId,
      harnessHash: harness.hash,
    }
  })
  const issues: string[] = []
  if (!models.length)
    issues.push('Connect provider accounts and select them in the desktop executor settings.')
  if (!workspaces.length) issues.push('Bind a project to a local workspace with a committed branch.')
  if (github.issue) issues.push(github.issue)
  return delegationModelCatalogSchema.parse({
    capability: DELEGATION_STAGE_CAPABILITY,
    enabled: models.length > 0 && workspaces.length > 0,
    revision: delegationCatalogRevision({ models, features, workspaces }),
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    workspaces,
    models,
    features,
    issues,
  })
}
