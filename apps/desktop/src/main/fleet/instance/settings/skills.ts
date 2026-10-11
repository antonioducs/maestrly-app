import os from 'node:os'
import path from 'node:path'
import type { FleetEnvironmentSettingsService, FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import {
  createSkillDocument,
  readSkillDocument,
  writeSkillDocument,
  withSkillMutation,
  assertSkillDocumentName,
} from '../../../chat/skill-document'
import type { ChatSkillInfo } from '../../../../shared/chat'
import { skillInstallRoot } from '../../../chat/skills'
import {
  createSkillGroup,
  updateSkillGroup,
  removeSkillGroup,
  listSkillGroups,
  listSkillsState,
  readSkillDetail,
  setSkillEnabledGlobal,
} from '../../../chat/skill-state'
import { installSkillFromSlug, searchSkillLibrary, removeGlobalSkill } from '../../../chat/skills-registry'
import { observeSettingsRevision, settingsRevision, withSettingsRevision } from './revisions'
import { InstanceHttpError } from '../server'

type SkillOperations =
  | 'skills'
  | 'skill'
  | 'createSkill'
  | 'writeSkill'
  | 'setSkillEnabled'
  | 'removeSkill'
  | 'searchSkills'
  | 'installSkill'
  | 'skillGroups'
  | 'createSkillGroup'
  | 'updateSkillGroup'
  | 'removeSkillGroup'
export type FleetSkillSettingsService = Pick<FleetEnvironmentSettingsService, SkillOperations>

function failure(code: string): never {
  if (code === 'stale-revision') throw new InstanceHttpError(409, 'CONFLICT', 'Settings changed. Reload before saving.')
  if (code === 'not-found') throw new InstanceHttpError(404, 'NOT_FOUND', 'Skill not found.')
  if (code === 'already-exists') throw new InstanceHttpError(409, 'CONFLICT', 'Skill already exists.')
  throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The skill operation could not be completed.')
}

/** Home injection is for synthetic tests only; remote requests never accept filesystem paths. */
export function createSkillSettingsService(home = os.homedir()): FleetSkillSettingsService {
  const root = skillInstallRoot('global', '', home)
  const resource = (name: string) => 'skill:' + name
  const read = async (
    name: string,
    known?: ChatSkillInfo,
    includeFiles = true
  ): Promise<FleetSettingsOutput<'skill'>> => {
    assertSkillDocumentName(name)
    const info =
      known ??
      (await listSkillsState(undefined, home)).skills.find((skill) => skill.scope === 'global' && skill.name === name)
    const document = await readSkillDocument(root, name, info?.dir)
    const detail = info && includeFiles ? await readSkillDetail(name, undefined, home) : null
    if (document.editableReason === 'not-found') {
      observeSettingsRevision(resource(name), ['missing'])
      failure('not-found')
    }
    const enabled = info?.enabledGlobally ?? true
    const source = info?.installedFrom === 'fleet' ? 'fleet' : info?.installedFrom ? 'registry' : 'local'
    const revision = observeSettingsRevision(resource(name), [document.fingerprint, enabled, source])
    return {
      name,
      description: (info?.description ?? '').slice(0, 4096),
      enabled,
      source,
      revision,
      editable: document.editable,
      resources: info?.resources ?? { scripts: 0, references: 0, assets: 0 },
      modelInvocable: info?.modelInvocable ?? true,
      userInvocable: info?.userInvocable ?? true,
      files: ['SKILL.md', ...(detail?.files ?? []).filter((file) => file !== 'SKILL.md' && file.length <= 240)].slice(
        0,
        400
      ),
      editableReason: document.editableReason,
      markdown: document.markdown,
    }
  }
  const summary = (document: FleetSettingsOutput<'skill'>): FleetSettingsOutput<'setSkillEnabled'> => {
    const { markdown: _, files: _files, ...info } = document
    return info
  }
  const groups = async (): Promise<FleetSettingsOutput<'skillGroups'>> => {
    const all = listSkillGroups()
    return {
      revision: observeSettingsRevision('skill-groups', all),
      groups: all.map(({ id, name, description, skills }) => ({ id, name, description, skills })),
    }
  }
  const mutate = async <T>(name: string, expected: string, action: () => Promise<T>, editable = true): Promise<T> => {
    assertSkillDocumentName(name)
    return withSkillMutation(path.join(root, name), async () => {
      const current = await read(name)
      if (editable && !current.editable) failure('read-only')
      return withSettingsRevision(resource(name), expected, action)
    })
  }
  const mutateGroup = async (expected: string, action: () => { ok: boolean; error?: string }) => {
    await groups()
    await withSettingsRevision('skill-groups', expected, () => {
      // Global group mutations are synchronous and share the existing store.
      const result = action()
      if (!result.ok) failure(result.error ?? 'invalid-input')
    })
    return groups()
  }
  const service: FleetSkillSettingsService = {
    async skills() {
      const all = (await listSkillsState(undefined, home)).skills.filter((skill) => skill.scope === 'global')
      return { skills: await Promise.all(all.map(async (info) => summary(await read(info.name, info, false)))) }
    },
    async skill({ name }) {
      return read(name)
    },
    async createSkill(input) {
      await createSkillDocument({ root, name: input.name, markdown: input.markdown })
      return read(input.name)
    },
    async writeSkill(input) {
      await mutate(input.name, input.expectedRevision, async () => {
        const document = await readSkillDocument(root, input.name)
        // Refresh after acquiring the lock and before obtaining the write snapshot.
        const current = await read(input.name)
        if (current.revision !== input.expectedRevision) failure('stale-revision')
        await writeSkillDocument({
          root,
          name: input.name,
          markdown: input.markdown,
          expectedFingerprint: document.fingerprint,
          beforeCommit: () => {
            if (settingsRevision(resource(input.name)) !== input.expectedRevision) failure('stale-revision')
          },
        })
      })
      return read(input.name)
    },
    async setSkillEnabled(input) {
      await mutate(
        input.name,
        input.expectedRevision,
        async () => {
          setSkillEnabledGlobal(input.name, input.enabled)
        },
        false
      )
      return summary(await read(input.name))
    },
    async removeSkill(input) {
      const removed = await mutate(input.name, input.expectedRevision, () => removeGlobalSkill(input.name, root))
      return { removed }
    },
    async searchSkills({ query }) {
      const result = await searchSkillLibrary(query)
      if (!result.ok) failure('search-failed')
      return {
        results: result.hits
          .slice(0, 100)
          .map((hit) => ({ id: hit.id, name: hit.name, description: '', source: hit.source })),
      }
    },
    async installSkill(input) {
      const skill = input.id.startsWith(input.source + '/') ? input.id.slice(input.source.length + 1) : input.id
      assertSkillDocumentName(skill)
      if (input.overwrite && !input.expectedRevision) failure('invalid-input')
      await withSkillMutation(path.join(root, skill), async () => {
        const validateRevision = async () => {
          const current = await read(skill)
          if (current.revision !== input.expectedRevision) throw new Error('stale-revision')
          if (!current.editable) throw new Error('read-only')
        }
        if (input.overwrite) await validateRevision()
        const result = await installSkillFromSlug({
          slug: `${input.source}@${skill}`,
          scope: 'global',
          cwd: '',
          home,
          overwrite: input.overwrite,
          expectedName: skill,
          beforeCommit: input.overwrite ? validateRevision : undefined,
        })
        if (!result.ok) failure(result.error ?? 'install-failed')
      })
      return service.skills({})
    },
    async skillGroups() {
      return groups()
    },
    async createSkillGroup(input) {
      return mutateGroup(input.expectedRevision, () => createSkillGroup(input))
    },
    async updateSkillGroup(input) {
      return mutateGroup(input.expectedRevision, () => updateSkillGroup(input.id, input))
    },
    async removeSkillGroup(input) {
      return mutateGroup(input.expectedRevision, () => removeSkillGroup(input.id))
    },
  }
  // Normalize filesystem/parser errors so transport never leaks a local filesystem path.
  return Object.fromEntries(
    Object.entries(service).map(([name, operation]) => [
      name,
      async (input: never) => {
        try {
          return await operation(input)
        } catch (error) {
          if (error instanceof InstanceHttpError) throw error
          const code = (error as NodeJS.ErrnoException)?.code
          failure(code === 'EEXIST' ? 'already-exists' : error instanceof Error ? error.message : 'invalid-input')
        }
      },
    ])
  ) as FleetSkillSettingsService
}
