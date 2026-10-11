import { describe, expect, it, vi } from 'vitest'
import type { FleetEnvironmentSettingsApi, FleetEnvironmentSettingsService } from '@maestrly/bot-fleet-protocol'
import {
  accountReplacementFields,
  createEnvironmentSettingsSource,
} from '../../src/renderer/lib/fleet/environment-settings'
import { createEnvironmentSkillsSource } from '../../src/renderer/components/chat/skills-settings-source'
import {
  emptyMcpDraft,
  mcpCreateInput,
  mcpPatchInput,
  mcpSecretValues,
} from '../../src/renderer/components/chat/mcp-settings-source'

describe('environment settings renderer sources', () => {
  it('omits protected account fields on name-only saves', () => {
    expect(accountReplacementFields({ baseURL: '', apiKey: '' })).toEqual({})
    expect(
      accountReplacementFields({ baseURL: 'https://api.example.test/?token=replacement', apiKey: 'new-key' })
    ).toEqual({ baseURL: 'https://api.example.test/?token=replacement', apiKey: 'new-key' })
  })
  it('requires a replacement destination and drops incompatible transport fields', () => {
    const draft = {
      ...emptyMcpDraft(),
      transport: 'stdio' as const,
      headers: 'TOKEN=old',
      url: 'https://old.example.test',
    }
    expect(() => mcpPatchInput('server', 'r1', draft, 'http')).toThrow('replacement-destination-required')
    expect(mcpPatchInput('server', 'r1', { ...draft, command: 'new-command', env: 'KEY=value' }, 'http')).toMatchObject(
      { transport: 'stdio', replace: { command: 'new-command' }, env: { set: { KEY: 'value' } } }
    )
    expect(mcpPatchInput('server', 'r1', { ...draft, command: 'new-command' }, 'http')).not.toHaveProperty('headers')
    const http = mcpPatchInput('server', 'r1', { ...draft, transport: 'http', args: 'invalid-json' }, 'stdio')
    expect(http).toMatchObject({ transport: 'http', replace: { url: draft.url } })
    expect(http).not.toHaveProperty('env')
  })
  it('confirms existing skills, forwards overwrite revision, and accepts manual slugs', async () => {
    const installSkill = vi.fn().mockResolvedValue({ skills: [] })
    const source = createEnvironmentSkillsSource({
      skills: vi.fn().mockResolvedValue({ skills: [{ name: 'example', revision: 'r1' }] }),
      skillGroups: vi.fn().mockResolvedValue({ revision: 'g1', groups: [] }),
      installSkill,
    } as unknown as FleetEnvironmentSettingsService)
    await source.chatSkillsState()
    expect(await source.chatSkillInstall({ slug: 'owner/repo@example' })).toMatchObject({
      ok: false,
      error: 'already-exists',
    })
    expect(installSkill).not.toHaveBeenCalled()
    await source.chatSkillInstall({ slug: 'owner/repo@example', overwrite: true })
    expect(installSkill).toHaveBeenCalledWith({
      source: 'owner/repo',
      id: 'example',
      overwrite: true,
      expectedRevision: 'r1',
    })
    await source.chatSkillInstall({ slug: 'owner/repo@new-skill' })
    expect(installSkill).toHaveBeenLastCalledWith({ source: 'owner/repo', id: 'new-skill' })
  })
  it('binds reads and writes to the selected environment without a local fallback', async () => {
    const accounts = vi.fn().mockResolvedValue({ revision: 'r1', apiKeys: [], subscriptions: [] })
    const patchAccount = vi.fn().mockResolvedValue({ revision: 'r2', apiKeys: [], subscriptions: [] })
    const api = { accounts, patchAccount } as unknown as FleetEnvironmentSettingsApi
    const first = createEnvironmentSettingsSource('environment-a', api)
    const second = createEnvironmentSettingsSource('environment-b', api)
    await first.accounts({})
    await second.patchAccount({ providerId: 'provider', expectedRevision: 'r1', name: 'Shared account' })
    expect(accounts).toHaveBeenCalledWith('environment-a', {})
    expect(patchAccount).toHaveBeenCalledWith('environment-b', {
      providerId: 'provider',
      expectedRevision: 'r1',
      name: 'Shared account',
    })
  })
  it('ignores late completions and prevents follow-up requests after switching targets', async () => {
    let resolve!: (value: unknown) => void
    let current = true
    const accounts = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const api = { accounts } as unknown as FleetEnvironmentSettingsApi
    const source = createEnvironmentSettingsSource('environment-a', api, () => current)
    const pending = source.accounts({})
    current = false
    resolve({ revision: 'late', apiKeys: [], subscriptions: [] })
    await expect(pending).rejects.toThrow('cancelled')
    await expect(source.accounts({})).rejects.toThrow('cancelled')
    expect(accounts).toHaveBeenCalledTimes(1)
  })
  it('keeps protected MCP values absent unless explicitly replaced or removed', () => {
    const draft = { ...emptyMcpDraft(), name: 'Shared tools' }
    const patch = mcpPatchInput('server', 'revision-a', draft)
    expect(patch.replace).toEqual({})
    expect(patch.env).toBeUndefined()
    expect(patch.headers).toEqual({ set: undefined, remove: [] })
    expect(patch.expectedRevision).toBe('revision-a')
    expect(
      mcpPatchInput('server', 'revision-a', { ...draft, transport: 'stdio', args: '[]', removeEnv: ['OLD_KEY'] })
    ).toMatchObject({ replace: { args: [] }, env: { remove: ['OLD_KEY'] } })
  })
  it('preserves equals signs in replacement values and validates argument arrays', () => {
    expect(mcpSecretValues('TOKEN=synthetic=value\nEMPTY=')).toEqual({ TOKEN: 'synthetic=value', EMPTY: '' })
    expect(() => mcpSecretValues('missing separator')).toThrow()
    expect(() => mcpCreateInput({ ...emptyMcpDraft(), transport: 'stdio', args: '{"invalid":true}' })).toThrow()
    expect(mcpCreateInput({ ...emptyMcpDraft(), name: 'Tools', url: 'https://tools.example.test/mcp' })).toMatchObject({
      transport: 'http',
      url: 'https://tools.example.test/mcp',
    })
  })
  it('adapts remote skills and groups and submits the read revision on writes', async () => {
    const api = {
      skills: vi.fn().mockResolvedValue({
        skills: [
          {
            name: 'synthetic-skill',
            description: 'A test skill',
            source: 'fleet',
            enabled: true,
            revision: 'skill-r1',
            editable: true,
            editableReason: null,
          },
        ],
      }),
      skillGroups: vi.fn().mockResolvedValue({
        revision: 'groups-r1',
        groups: [{ id: 'group-a', name: 'Test group', skills: ['synthetic-skill'] }],
      }),
      setSkillEnabled: vi.fn().mockResolvedValue({}),
      updateSkillGroup: vi.fn().mockResolvedValue({
        revision: 'groups-r2',
        groups: [{ id: 'group-a', name: 'Renamed group', skills: ['synthetic-skill'] }],
      }),
    } as unknown as FleetEnvironmentSettingsService
    const source = createEnvironmentSkillsSource(api)
    const state = await source.chatSkillsState()
    expect(state.skills[0]).toMatchObject({ dir: '', groupIds: ['group-a'], enabledGlobally: true })
    await source.chatSkillSetEnabled('synthetic-skill', false)
    await source.chatSkillGroupUpdate('group-a', { name: 'Renamed group' })
    expect(api.setSkillEnabled).toHaveBeenCalledWith({
      name: 'synthetic-skill',
      expectedRevision: 'skill-r1',
      enabled: false,
    })
    expect(api.updateSkillGroup).toHaveBeenCalledWith({
      id: 'group-a',
      expectedRevision: 'groups-r1',
      name: 'Renamed group',
      skills: ['synthetic-skill'],
    })
    expect(await source.chatSkillReveal('synthetic-skill')).toEqual({ ok: false })
  })
  it('does not refresh or retry a conflicting skill write with a newer revision', async () => {
    const skills = vi.fn().mockResolvedValue({
      skills: [
        {
          name: 'synthetic-skill',
          description: '',
          source: 'fleet',
          enabled: true,
          revision: 'skill-r1',
          editable: true,
          editableReason: null,
        },
      ],
    })
    const setSkillEnabled = vi.fn().mockRejectedValue(new Error('conflict'))
    const source = createEnvironmentSkillsSource({
      skills,
      skillGroups: vi.fn().mockResolvedValue({ revision: 'groups-r1', groups: [] }),
      setSkillEnabled,
    } as unknown as FleetEnvironmentSettingsService)
    await source.chatSkillsState()
    await expect(source.chatSkillSetEnabled('synthetic-skill', false)).rejects.toThrow('conflict')
    expect(setSkillEnabled).toHaveBeenCalledTimes(1)
    expect(skills).toHaveBeenCalledTimes(1)
  })
  it('uses environment-only notifications and install metadata from remote search', async () => {
    const installSkill = vi.fn().mockResolvedValue({ skills: [] })
    const source = createEnvironmentSkillsSource({
      searchSkills: vi.fn().mockResolvedValue({
        results: [{ id: 'library-skill', name: 'Library skill', description: '', source: 'test-library' }],
      }),
      installSkill,
    } as unknown as FleetEnvironmentSettingsService)
    const other = createEnvironmentSkillsSource({} as FleetEnvironmentSettingsService)
    const changed = vi.fn()
    const unrelated = vi.fn()
    const unsubscribe = source.subscribe(changed)
    other.subscribe(unrelated)
    source.notifyChanged()
    unsubscribe()
    source.notifyChanged()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(unrelated).not.toHaveBeenCalled()
    await source.chatSkillSearch('library')
    await source.chatSkillInstall({ slug: 'library-skill' })
    expect(installSkill).toHaveBeenCalledWith({ id: 'library-skill', source: 'test-library' })
  })
  it('keeps the newest remote skill revision when overlapping refreshes finish out of order', async () => {
    let resolveOld!: (value: unknown) => void
    const skill = {
      name: 'synthetic-skill',
      description: '',
      source: 'fleet',
      enabled: true,
      editable: true,
      editableReason: null,
    }
    const skills = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      .mockResolvedValue({ skills: [{ ...skill, revision: 'new-revision' }] })
    const setSkillEnabled = vi.fn().mockResolvedValue({})
    const source = createEnvironmentSkillsSource({
      skills,
      skillGroups: vi.fn().mockResolvedValue({ revision: 'groups', groups: [] }),
      setSkillEnabled,
    } as unknown as FleetEnvironmentSettingsService)
    const old = source.chatSkillsState()
    await source.chatSkillsState()
    resolveOld({ skills: [{ ...skill, revision: 'old-revision' }] })
    await old
    await source.chatSkillSetEnabled('synthetic-skill', false)
    expect(setSkillEnabled).toHaveBeenCalledWith({
      name: 'synthetic-skill',
      expectedRevision: 'new-revision',
      enabled: false,
    })
  })
})
