/**
 * Skill ENABLEMENT state — connects the pure engine (`skills.ts`) to the store.
 *
 * Effective precedence:
 *   1. Global state;
 *   2. Conversation set (all / none / a group);
 *   3. Individual conversation override (`on` / `off`).
 *
 * `effectiveSkills` remains the sole entry point for runtimes, `/` palette, and user invocation.
 */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type {
  ChatSkillDetail,
  ChatSkillGroup,
  ChatSkillInfo,
  ChatSkillSelection,
  ChatSkillsState,
} from '../../shared/chat'
import { getAppSetting, getConversation, getConvUiPrefs, patchConvUiPrefs, setAppSetting } from '../store'
import { countSkillResources, listSkills, normalizedSkillName, type ChatSkill, type SkillOverride } from './skills'
import { listInstalledSkillSources } from './skills-registry'

const DISABLED_KEY = 'chat.skills.disabled'
const GROUPS_KEY = 'chat.skills.groups.v1'
const MAX_GROUPS = 100
const MAX_GROUP_SKILLS = 500
const MAX_GROUP_NAME = 80
const MAX_GROUP_DESCRIPTION = 500
const ALL_SELECTION: ChatSkillSelection = { kind: 'all' }

export interface SkillGroupWriteResult {
  ok: boolean
  error?: 'invalid-name' | 'duplicate-name' | 'not-found' | 'too-many-groups' | 'too-many-skills'
  group?: ChatSkillGroup
}

function normalizedGroupName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME) : ''
}

function normalizedDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_DESCRIPTION) || undefined
}

function normalizedMembers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = normalizedSkillName(item)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= MAX_GROUP_SKILLS) break
  }
  return out
}

function sanitizeGroup(value: unknown): ChatSkillGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 128) : ''
  const name = normalizedGroupName(raw.name)
  if (!id || !name) return null
  const description = normalizedDescription(raw.description)
  return {
    id,
    name,
    ...(description ? { description } : {}),
    skills: normalizedMembers(raw.skills),
  }
}

/** Global groups, defensively validated and deduplicated by ID/name. */
export function listSkillGroups(): ChatSkillGroup[] {
  const raw = getAppSetting(GROUPS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const ids = new Set<string>()
    const names = new Set<string>()
    const out: ChatSkillGroup[] = []
    for (const value of parsed) {
      const group = sanitizeGroup(value)
      const nameKey = group?.name.toLowerCase()
      if (!group || ids.has(group.id) || !nameKey || names.has(nameKey)) continue
      ids.add(group.id)
      names.add(nameKey)
      out.push(group)
      if (out.length >= MAX_GROUPS) break
    }
    return out
  } catch {
    return []
  }
}

function saveSkillGroups(groups: readonly ChatSkillGroup[]): void {
  setAppSetting(GROUPS_KEY, JSON.stringify(groups))
}

export function createSkillGroup(input: {
  name: string
  description?: string
  skills?: string[]
}): SkillGroupWriteResult {
  const groups = listSkillGroups()
  if (groups.length >= MAX_GROUPS) return { ok: false, error: 'too-many-groups' }
  const name = normalizedGroupName(input?.name)
  if (!name) return { ok: false, error: 'invalid-name' }
  if (groups.some((group) => group.name.toLowerCase() === name.toLowerCase()))
    return { ok: false, error: 'duplicate-name' }
  if (Array.isArray(input?.skills) && input.skills.length > MAX_GROUP_SKILLS)
    return { ok: false, error: 'too-many-skills' }
  const description = normalizedDescription(input?.description)
  const group: ChatSkillGroup = {
    id: randomUUID(),
    name,
    ...(description ? { description } : {}),
    skills: normalizedMembers(input?.skills),
  }
  saveSkillGroups([...groups, group])
  return { ok: true, group }
}

export function updateSkillGroup(
  id: string,
  patch: { name?: string; description?: string; skills?: string[] }
): SkillGroupWriteResult {
  const groups = listSkillGroups()
  const index = groups.findIndex((group) => group.id === id)
  if (index < 0) return { ok: false, error: 'not-found' }
  const current = groups[index]
  const name = patch.name == null ? current.name : normalizedGroupName(patch.name)
  if (!name) return { ok: false, error: 'invalid-name' }
  if (groups.some((group) => group.id !== id && group.name.toLowerCase() === name.toLowerCase()))
    return { ok: false, error: 'duplicate-name' }
  if (Array.isArray(patch.skills) && patch.skills.length > MAX_GROUP_SKILLS)
    return { ok: false, error: 'too-many-skills' }
  const description = patch.description == null ? current.description : normalizedDescription(patch.description)
  const group: ChatSkillGroup = {
    id: current.id,
    name,
    ...(description ? { description } : {}),
    skills: patch.skills == null ? current.skills : normalizedMembers(patch.skills),
  }
  groups[index] = group
  saveSkillGroups(groups)
  return { ok: true, group }
}

export function removeSkillGroup(id: string): SkillGroupWriteResult {
  const groups = listSkillGroups()
  if (!groups.some((group) => group.id === id)) return { ok: false, error: 'not-found' }
  saveSkillGroups(groups.filter((group) => group.id !== id))
  // Conversations referencing the group retain the orphan selection. The resolver treats it as `none`,
  // avoiding silently enabling all skills.
  return { ok: true }
}

/** Globally DISABLED names. */
export function listGloballyDisabledSkills(): string[] {
  const raw = getAppSetting(DISABLED_KEY)
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && !!x) : []
  } catch {
    return []
  }
}

export function setSkillEnabledGlobal(name: string, enabled: boolean): void {
  const norm = normalizedSkillName(name)
  if (!norm) return
  const current = new Set(listGloballyDisabledSkills())
  if (enabled) current.delete(norm)
  else current.add(norm)
  setAppSetting(DISABLED_KEY, JSON.stringify([...current]))
}

/** Conversation overrides (name → 'on' | 'off'). */
export function conversationSkillOverrides(conversationId: string): Record<string, SkillOverride> {
  if (!conversationId) return {}
  const raw = getConvUiPrefs(conversationId).chat?.skills
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, SkillOverride> = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = normalizedSkillName(key)
    if (name && (value === 'on' || value === 'off')) out[name] = value
  }
  return out
}

export function conversationSkillSelection(conversationId?: string): ChatSkillSelection {
  if (!conversationId) return ALL_SELECTION
  const raw = getConvUiPrefs(conversationId).chat?.skillSelection
  if (raw?.kind === 'none') return { kind: 'none' }
  if (raw?.kind === 'group' && typeof raw.groupId === 'string') {
    const groupId = raw.groupId.trim().slice(0, 128)
    if (groupId) return { kind: 'group', groupId }
  }
  return ALL_SELECTION
}

/** Changes the base set and clears exceptions in one write. */
export function setConversationSkillSelection(
  conversationId: string,
  selection: ChatSkillSelection
): { ok: boolean; error?: 'invalid-input' | 'group-not-found' } {
  if (!conversationId || !selection || !['all', 'none', 'group'].includes(selection.kind))
    return { ok: false, error: 'invalid-input' }
  let canonical: ChatSkillSelection
  if (selection.kind === 'group') {
    const groupId = typeof selection.groupId === 'string' ? selection.groupId.trim().slice(0, 128) : ''
    if (!groupId) return { ok: false, error: 'invalid-input' }
    if (!listSkillGroups().some((group) => group.id === groupId)) return { ok: false, error: 'group-not-found' }
    canonical = { kind: 'group', groupId }
  } else {
    canonical = { kind: selection.kind }
  }
  const chat = getConvUiPrefs(conversationId).chat ?? {}
  patchConvUiPrefs(conversationId, { chat: { ...chat, skillSelection: canonical, skills: {} } })
  return { ok: true }
}

export function resetConversationSkillOverrides(conversationId: string): { ok: boolean } {
  if (!conversationId) return { ok: false }
  const chat = getConvUiPrefs(conversationId).chat ?? {}
  patchConvUiPrefs(conversationId, { chat: { ...chat, skills: {} } })
  return { ok: true }
}

/** Sets (or clears with 'inherit') a conversation skill override. */
export function setConversationSkillOverride(
  conversationId: string,
  name: string,
  state: SkillOverride | 'inherit'
): void {
  const norm = normalizedSkillName(name)
  if (!conversationId || !norm) return
  const chat = getConvUiPrefs(conversationId).chat ?? {}
  const skills = { ...(chat.skills ?? {}) }
  if (state === 'inherit') delete skills[norm]
  else skills[norm] = state
  patchConvUiPrefs(conversationId, { chat: { ...chat, skills } })
}

/** Conversation cwd (empty without a conversation, e.g. Settings sees global skills only). */
export function conversationCwd(conversationId?: string): string {
  if (!conversationId) return ''
  return getConversation(conversationId)?.cwd ?? ''
}

export function skillBaseIsEnabled(
  name: string,
  disabled: ReadonlySet<string>,
  selection: ChatSkillSelection,
  groups: readonly ChatSkillGroup[]
): boolean {
  if (disabled.has(name)) return false
  if (selection.kind === 'all') return true
  if (selection.kind === 'none') return false
  const group = groups.find((item) => item.id === selection.groupId)
  return group?.skills.includes(name) ?? false
}

export function skillIsEnabledForSelection(
  name: string,
  disabled: ReadonlySet<string>,
  selection: ChatSkillSelection,
  groups: readonly ChatSkillGroup[],
  overrides: Readonly<Record<string, SkillOverride>>
): boolean {
  const override = overrides[name]
  if (override === 'on') return true
  if (override === 'off') return false
  return skillBaseIsEnabled(name, disabled, selection, groups)
}

/** ENABLED skills (global + set + conversation override). */
export async function effectiveSkills(
  cwd: string,
  conversationId?: string,
  home: string = os.homedir()
): Promise<ChatSkill[]> {
  const disabled = new Set(listGloballyDisabledSkills())
  const overrides = conversationId ? conversationSkillOverrides(conversationId) : {}
  const selection = conversationSkillSelection(conversationId)
  const groups = listSkillGroups()
  const all = await listSkills(cwd, home)
  return all.filter((skill) => skillIsEnabledForSelection(skill.name, disabled, selection, groups, overrides))
}

/** An ENABLED skill by name — used by `use_skill` and `/name` invocation. */
export async function findEffectiveSkill(
  cwd: string,
  conversationId: string | undefined,
  name: string,
  home: string = os.homedir()
): Promise<ChatSkill | null> {
  const norm = normalizedSkillName(name)
  if (!norm) return null
  return (await effectiveSkills(cwd, conversationId, home)).find((skill) => skill.name === norm) ?? null
}

function toInfo(
  skill: ChatSkill,
  disabled: ReadonlySet<string>,
  overrides: Readonly<Record<string, SkillOverride>>,
  selection: ChatSkillSelection,
  groups: readonly ChatSkillGroup[],
  installed: Readonly<Record<string, string>>
): ChatSkillInfo {
  const baseEnabled = skillBaseIsEnabled(skill.name, disabled, selection, groups)
  const groupIds = groups.filter((group) => group.skills.includes(skill.name)).map((group) => group.id)
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    dir: skill.dir,
    scope: skill.scope,
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    ...(skill.license ? { license: skill.license } : {}),
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
    resources: countSkillResources(skill.resources),
    enabled: skillIsEnabledForSelection(skill.name, disabled, selection, groups, overrides),
    baseEnabled,
    enabledGlobally: !disabled.has(skill.name),
    ...(overrides[skill.name] ? { override: overrides[skill.name] } : {}),
    groupIds,
    inSelectedGroup: selection.kind === 'group' && groupIds.includes(selection.groupId),
    ...(installed[skill.name] ? { installedFrom: installed[skill.name] } : {}),
  }
}

/** Consistent payload (skills + groups + selection) for Settings and conversation menu. */
export async function listSkillsState(conversationId?: string, home: string = os.homedir()): Promise<ChatSkillsState> {
  const cwd = conversationCwd(conversationId)
  const disabled = new Set(listGloballyDisabledSkills())
  const overrides = conversationId ? conversationSkillOverrides(conversationId) : {}
  const selection = conversationSkillSelection(conversationId)
  const groups = listSkillGroups()
  const installed = listInstalledSkillSources()
  const skills = await listSkills(cwd, home)
  const infos = skills.map((skill) => toInfo(skill, disabled, overrides, selection, groups, installed))
  return {
    skills: infos,
    groups,
    selection,
    selectedGroupMissing: selection.kind === 'group' && !groups.some((group) => group.id === selection.groupId),
    hasOverrides: infos.some((skill) => skill.override !== undefined),
  }
}

/** Compatibility for existing callers needing only the list. */
export async function listSkillInfos(conversationId?: string, home: string = os.homedir()): Promise<ChatSkillInfo[]> {
  return (await listSkillsState(conversationId, home)).skills
}

/** Skill details (body + bundled files) for the "view" panel. */
export async function readSkillDetail(
  name: string,
  conversationId?: string,
  home: string = os.homedir()
): Promise<ChatSkillDetail | null> {
  const cwd = conversationCwd(conversationId)
  const norm = normalizedSkillName(name)
  if (!norm) return null
  const skill = (await listSkills(cwd, home)).find((item) => item.name === norm)
  if (!skill) return null
  const disabled = new Set(listGloballyDisabledSkills())
  const overrides = conversationId ? conversationSkillOverrides(conversationId) : {}
  const selection = conversationSkillSelection(conversationId)
  const groups = listSkillGroups()
  return {
    ...toInfo(skill, disabled, overrides, selection, groups, listInstalledSkillSources()),
    body: skill.body,
    files: skill.resources,
  }
}
