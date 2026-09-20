import { expect, it } from 'vitest'
import { resolveStageSettings, assertStageSettingsStillValid } from '@maestrly/protocol'
import { buildDelegationCatalog } from '../../src/main/platform/delegation-catalog'
import { chatWorkspaceKey } from '../../src/main/platform/project-chat-projection'
import { desktopExecutorSettingsSchema } from '../../src/main/platform/executor-settings'
import type { LocalModelSelection } from '../../src/main/platform/desktop-executor'
import type { PlatformProjectBinding } from '../../src/main/../shared/platform'

const binding = (overrides: Partial<PlatformProjectBinding> = {}): PlatformProjectBinding =>
  ({
    connectionId: 'conn-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    repositoryBindingId: 'repo-1',
    ...overrides,
  }) as PlatformProjectBinding

const selection = (overrides: Partial<LocalModelSelection>): LocalModelSelection => ({
  selectionId: 'sel-a',
  providerId: 'codex-subscription',
  modelId: 'gpt-6-astra',
  providerLabel: 'Codex · personal',
  label: 'Codex · gpt-6-astra',
  reasoningEfforts: ['medium', 'high'],
  fastMode: false,
  ...overrides,
})

const settings = desktopExecutorSettingsSchema.parse({ providerIds: ['codex-subscription'], allowCommands: true })

function catalogInput(selections: LocalModelSelection[], overrides: Record<string, unknown> = {}) {
  return {
    catalog: { selections: async () => selections },
    settings,
    bindings: [binding()],
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    workspacePathFor: () => '/tmp/workspace',
    inspect: async () => [{ bindingId: 'conn-1:project-1:workspace-1', available: true, branches: ['main'] }],
    probes: {
      profiles: async () => ['general-purpose', 'explore'],
      github: async () => ({ available: true, login: 'octocat', issue: null }),
      checks: async () => [
        { id: 'unit', label: 'Unit tests', description: '', required: true, mutatesWorkspace: false },
      ],
    },
    ...overrides,
  }
}

it('publishes one opaque selection per account/model with the real efforts and Fast support', async () => {
  const catalog = await buildDelegationCatalog(
    catalogInput([
      selection({ selectionId: 'sel-astra' }),
      selection({
        selectionId: 'sel-opus',
        providerId: 'claude-subscription',
        modelId: 'claude-opus-5',
        providerLabel: 'Claude · personal',
        reasoningEfforts: ['low', 'medium', 'high'],
        fastMode: true,
      }),
    ])
  )
  expect(catalog.capability).toBe('delegation:stages:v1')
  expect(catalog.models.map((model) => model.selectionId)).toEqual(['sel-astra', 'sel-opus'])
  const astra = catalog.models[0]!
  const opus = catalog.models[1]!
  expect(astra.accountLabel).toBe('Codex · personal')
  expect(astra.efforts).toEqual(['medium', 'high'])
  expect(astra.fastMode).toBe(false)
  expect(opus.fastMode).toBe(true)
  expect(astra.delegationProfiles).toEqual(['general-purpose', 'explore'])
  expect(catalog.features.checks.map((check) => check.id)).toEqual(['unit'])
  expect(catalog.features.github).toMatchObject({ available: true, login: 'octocat' })
  expect(catalog.revision).toMatch(/^[0-9a-f]{32}$/)
  expect(catalog.enabled).toBe(true)
  // The advertised key is the identity this computer resolves back when a stage is prepared.
  expect(catalog.workspaces).toEqual([
    {
      projectId: 'project-1',
      key: chatWorkspaceKey(binding()),
      label: 'project-1',
      branches: ['main'],
      repositoryBindingId: 'repo-1',
    },
  ])
  // It is opaque: the connection and workspace identifiers of this computer never leave it.
  expect(catalog.workspaces[0]!.key).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  expect(catalog.workspaces[0]!.key).not.toContain('workspace-1')

  // Two accounts serving the same model are distinct selections that resolve independently.
  const sameModel = await buildDelegationCatalog(
    catalogInput([
      selection({ selectionId: 'sel-opus-personal', modelId: 'claude-opus-5', providerLabel: 'Claude · personal', fastMode: true }),
      selection({ selectionId: 'sel-opus-team', modelId: 'claude-opus-5', providerLabel: 'Claude · team', reasoningEfforts: ['medium'] }),
    ])
  )
  const personal = resolveStageSettings(sameModel, { selectionId: 'sel-opus-personal', reasoning: 'high', fastMode: true })
  expect(personal.selection.accountLabel).toBe('Claude · personal')
  expect(() => resolveStageSettings(sameModel, { selectionId: 'sel-opus-team', reasoning: 'high' })).toThrowError(
    /unavailable for this model/
  )
})

it('changes the revision when the advertised capability changes and blocks a stale snapshot', async () => {
  const first = await buildDelegationCatalog(catalogInput([selection({ selectionId: 'sel-astra' })]))
  const resolved = resolveStageSettings(first, { selectionId: 'sel-astra', reasoning: 'high' })
  expect(assertStageSettingsStillValid(first, resolved.settings, resolved.catalogRevision).selectionId).toBe('sel-astra')

  const narrowed = await buildDelegationCatalog(
    catalogInput([selection({ selectionId: 'sel-astra', reasoningEfforts: ['medium'] })])
  )
  expect(narrowed.revision).not.toBe(first.revision)
  expect(() => assertStageSettingsStillValid(narrowed, resolved.settings, resolved.catalogRevision)).toThrowError(
    /reasoning effort chosen for this stage disappeared/
  )

  const removed = await buildDelegationCatalog(catalogInput([]))
  expect(removed.enabled).toBe(false)
  expect(removed.issues.some((issue) => issue.includes('Connect provider accounts'))).toBe(true)
  expect(() => assertStageSettingsStillValid(removed, resolved.settings, resolved.catalogRevision)).toThrowError(
    /no longer available/
  )
})

it('withholds capabilities the operator did not enable', async () => {
  const restricted = desktopExecutorSettingsSchema.parse({
    providerIds: ['codex-subscription'],
    allowCommands: false,
    allowWeb: false,
    allowAppTools: false,
  })
  const catalog = await buildDelegationCatalog(
    catalogInput([selection({ selectionId: 'sel-astra' })], { settings: restricted })
  )
  expect(catalog.features.checks).toEqual([])
  expect(catalog.features.preview.available).toBe(false)
  expect(catalog.features.browserInspect).toBe(false)
  expect(catalog.features.browserInteract).toBe(false)
  expect(catalog.features.subagents).toBe(false)
  expect(catalog.models[0]!.delegationProfiles).toEqual([])
  expect(() =>
    resolveStageSettings(catalog, { selectionId: 'sel-astra', delegationProfiles: ['general-purpose'] })
  ).toThrowError(/Unknown subagent profile/)
})
