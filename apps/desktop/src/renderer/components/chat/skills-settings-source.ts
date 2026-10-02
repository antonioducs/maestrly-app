import type { FleetEnvironmentSettingsService, FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import type { ChatSkillDetail, ChatSkillInfo } from '../../../shared/chat'
type Api = typeof window.api
export type SkillsSettingsSource = Pick<
  Api,
  | 'chatSkillsState'
  | 'chatSkillRead'
  | 'chatSkillSetEnabled'
  | 'chatSkillCreate'
  | 'chatSkillRemove'
  | 'chatSkillReveal'
  | 'chatSkillSearch'
  | 'chatSkillInstall'
  | 'chatSkillGroupCreate'
  | 'chatSkillGroupUpdate'
  | 'chatSkillGroupRemove'
> & {
  remote: boolean
  subscribe: (listener: () => void) => () => void
  notifyChanged: () => void
}
export const localSkillsSettingsSource: SkillsSettingsSource = {
  remote: false,
  chatSkillsState: (...args) => window.api.chatSkillsState(...args),
  chatSkillRead: (...args) => window.api.chatSkillRead(...args),
  chatSkillSetEnabled: (...args) => window.api.chatSkillSetEnabled(...args),
  chatSkillCreate: (...args) => window.api.chatSkillCreate(...args),
  chatSkillRemove: (...args) => window.api.chatSkillRemove(...args),
  chatSkillReveal: (...args) => window.api.chatSkillReveal(...args),
  chatSkillSearch: (...args) => window.api.chatSkillSearch(...args),
  chatSkillInstall: (...args) => window.api.chatSkillInstall(...args),
  chatSkillGroupCreate: (...args) => window.api.chatSkillGroupCreate(...args),
  chatSkillGroupUpdate: (...args) => window.api.chatSkillGroupUpdate(...args),
  chatSkillGroupRemove: (...args) => window.api.chatSkillGroupRemove(...args),
  subscribe: (listener) => {
    window.addEventListener('maestrly:skills-changed', listener)
    return () => window.removeEventListener('maestrly:skills-changed', listener)
  },
  notifyChanged: () => window.dispatchEvent(new Event('maestrly:skills-changed')),
}
export type EnvironmentSkillDetail = ChatSkillDetail & {
  revision: string
  editable: boolean
  editableReason: string | null
}
export function createEnvironmentSkillsSource(api: FleetEnvironmentSettingsService): SkillsSettingsSource {
  let skills: FleetSettingsOutput<'skills'>['skills'] = []
  let groups: FleetSettingsOutput<'skillGroups'> | null = null
  let hits: FleetSettingsOutput<'searchSkills'>['results'] = []
  const listeners = new Set<() => void>()
  let refreshRequest = 0
  const info = (skill: FleetSettingsOutput<'skills'>['skills'][number]): ChatSkillInfo => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    dir: '',
    scope: 'global',
    modelInvocable: skill.modelInvocable ?? true,
    userInvocable: skill.userInvocable ?? true,
    resources: skill.resources ?? { scripts: 0, references: 0, assets: 0 },
    enabled: skill.enabled,
    baseEnabled: skill.enabled,
    enabledGlobally: skill.enabled,
    groupIds: groups?.groups.filter((group) => group.skills.includes(skill.name)).map((group) => group.id) ?? [],
    inSelectedGroup: true,
  })
  const revision = (name: string) => {
    const skill = skills.find((s) => s.name === name)
    if (!skill) throw new Error('not-found')
    return skill.revision
  }
  const groupSnapshot = () => {
    if (!groups) throw new Error('not-loaded')
    return groups
  }
  return {
    remote: true,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notifyChanged: () => {
      for (const listener of listeners) listener()
    },
    async chatSkillsState() {
      const request = ++refreshRequest
      const [nextSkills, nextGroups] = await Promise.all([api.skills({}), api.skillGroups({})])
      if (request === refreshRequest) {
        skills = nextSkills.skills
        groups = nextGroups
      }
      return {
        skills: skills.map(info),
        groups: groups?.groups ?? [],
        selection: { kind: 'all' },
        selectedGroupMissing: false,
        hasOverrides: false,
      }
    },
    async chatSkillRead(name) {
      const document = await api.skill({ name })
      return {
        ...info(document),
        body: document.markdown,
        files: document.files ?? ['SKILL.md'],
        revision: document.revision,
        editable: document.editable,
        editableReason: document.editableReason,
      } as EnvironmentSkillDetail
    },
    async chatSkillSetEnabled(name, enabled) {
      await api.setSkillEnabled({ name, enabled, expectedRevision: revision(name) })
      return { ok: true }
    },
    async chatSkillCreate(input) {
      await api.createSkill({
        name: input.name,
        markdown: `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description ?? '')}\n---\n\n${input.description || '# ' + input.name}\n`,
      })
      return { ok: true, name: input.name }
    },
    async chatSkillRemove(name) {
      await api.removeSkill({ name, expectedRevision: revision(name) })
      return { ok: true }
    },
    async chatSkillReveal() {
      return { ok: false }
    },
    async chatSkillSearch(query) {
      hits = (await api.searchSkills({ query })).results
      return {
        ok: true,
        hits: hits.map((hit) => ({
          ...hit,
          slug: hit.id,
          installs: 0,
          url: '',
          installed: skills.some((skill) => skill.name === hit.name),
        })),
      }
    },
    async chatSkillInstall(input) {
      const manual = /^([\w.-]+\/[\w.-]+)@([\w.-]+)$/.exec(input.slug.trim())
      const hit =
        hits.find((h) => h.id === input.slug) ?? (manual ? { source: manual[1], id: manual[2], name: manual[2] } : null)
      if (!hit) return { ok: false, error: 'invalid-slug' }
      const existing = skills.find((skill) => skill.name === hit.name)
      if (existing && !input.overwrite) return { ok: false, error: 'already-exists', name: hit.name }
      await api.installSkill({
        id: hit.id,
        source: hit.source,
        ...(input.overwrite ? { overwrite: true, ...(existing ? { expectedRevision: existing.revision } : {}) } : {}),
      })
      return { ok: true }
    },
    async chatSkillGroupCreate(input) {
      const snapshot = groupSnapshot()
      groups = await api.createSkillGroup({
        expectedRevision: snapshot.revision,
        name: input.name,
        description: input.description,
        skills: input.skills ?? [],
      })
      return { ok: true, group: groups.groups.find((group) => !snapshot.groups.some((old) => old.id === group.id)) }
    },
    async chatSkillGroupUpdate(id, patch) {
      const snapshot = groupSnapshot()
      const current = snapshot.groups.find((group) => group.id === id)
      if (!current) return { ok: false, error: 'not-found' }
      groups = await api.updateSkillGroup({
        id,
        expectedRevision: snapshot.revision,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        skills: patch.skills ?? current.skills,
      })
      return { ok: true, group: groups.groups.find((group) => group.id === id) }
    },
    async chatSkillGroupRemove(id) {
      groups = await api.removeSkillGroup({ id, expectedRevision: groupSnapshot().revision })
      return { ok: true }
    },
  }
}
