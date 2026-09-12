import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getAppSetting,
  getConvUiPrefs,
  insertConversation,
  insertWorkspace,
  patchConvUiPrefs,
  setAppSetting,
} from '../../src/main/store'
import {
  getConversationSubagentProfileRules,
  getGlobalSubagentProfileRules,
  setConversationSubagentProfileRules,
  setConversationSubagentProfilesEnabled,
  setGlobalSubagentProfileRules,
  SUBAGENT_PROFILES_SETTING_KEY,
  validateSubagentProfileRules,
} from '../../src/main/chat/subagent-profile-config'
import { closeDb, freshDb } from '../helpers/db'

const profile = { providerId: 'provider', modelId: 'model', effort: 'high' }
const rules = { version: 1 as const, default: [profile], byAgent: { 'My Agent': [profile] } }

beforeEach(() => {
  freshDb()
  insertWorkspace({ id: 'w', path: '/tmp/w', name: 'W', defaultBranch: 'main', addedAt: 1 })
  insertConversation({
    id: 'c',
    workspaceId: 'w',
    name: 'C',
    branch: 'main',
    mode: 'local',
    experience: 'standard',
    cwd: '/tmp/w',
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
    isMulti: 0,
    uiPrefs: { chat: { providerId: 'parent', modelId: 'parent-model', reasoning: 'ultra', tools: { app: true } } },
  })
})
afterEach(closeDb)

describe('subagent profile config', () => {
  it('normalizes keys and round-trips global configuration', () => {
    const saved = setGlobalSubagentProfileRules(rules)
    expect(saved.ok).toBe(true)
    expect(getGlobalSubagentProfileRules().rules?.byAgent).toEqual({ 'my-agent': [profile] })
  })

  it('round-trips global and per-conversation Fast, omitting false in normalized form', () => {
    const fastRules = {
      version: 1 as const,
      default: [{ ...profile, fastMode: true }],
      byAgent: { Standard: [{ ...profile, fastMode: false }] },
    }
    expect(setGlobalSubagentProfileRules(fastRules).ok).toBe(true)
    expect(getGlobalSubagentProfileRules().rules).toEqual({
      version: 1,
      default: [{ ...profile, fastMode: true }],
      byAgent: { standard: [profile] },
    })
    expect(setConversationSubagentProfileRules('c', fastRules).ok).toBe(true)
    expect(getConversationSubagentProfileRules('c').rules).toEqual({
      version: 1,
      default: [{ ...profile, fastMode: true }],
      byAgent: { standard: [profile] },
    })
  })

  it('rejects invalid structures, new synthetic efforts, and normalized collisions without persisting', () => {
    expect(validateSubagentProfileRules({ version: 1, default: [{ providerId: 'p' }] }).ok).toBe(false)
    expect(setGlobalSubagentProfileRules({ version: 1, default: [] }).ok).toBe(false)
    for (const effort of ['', 'off', 'maestrly-ultra']) {
      expect(
        setGlobalSubagentProfileRules({
          version: 1,
          default: [{ providerId: 'p', modelId: 'm', effort }],
        }).ok
      ).toBe(false)
    }
    expect(
      setGlobalSubagentProfileRules({ version: 1, byAgent: { foo_bar: [profile], 'foo-bar': [profile] } }).ok
    ).toBe(false)
    expect(getAppSetting(SUBAGENT_PROFILES_SETTING_KEY)).toBeNull()
  })

  it('rejects non-boolean fastMode', () => {
    for (const fastMode of ['true', 1, null]) {
      const result = validateSubagentProfileRules({ version: 1, default: [{ ...profile, fastMode }] })
      expect(result).toMatchObject({ ok: false, errors: [{ code: 'invalid-structure' }] })
    }
  })

  it('corrupted global configuration falls back to a safe default with diagnostics', () => {
    setAppSetting(SUBAGENT_PROFILES_SETTING_KEY, '{broken')
    expect(getGlobalSubagentProfileRules()).toMatchObject({
      rules: null,
      diagnostics: [{ code: 'config-corrupt' }],
    })
  })

  it('conversation round-trip/removal preserves neighboring preferences and orphan references', () => {
    const orphan = { version: 1 as const, default: [{ providerId: 'removed', modelId: 'manual', effort: 'high' }] }
    expect(setConversationSubagentProfileRules('c', orphan).ok).toBe(true)
    expect(getConversationSubagentProfileRules('c').rules).toEqual(orphan)
    expect(getConvUiPrefs('c').chat).toMatchObject({
      providerId: 'parent',
      modelId: 'parent-model',
      reasoning: 'ultra',
      tools: { app: true },
    })
    expect(setConversationSubagentProfileRules('c', null).ok).toBe(true)
    expect(getConversationSubagentProfileRules('c').rules).toBeNull()
    expect(getConvUiPrefs('c').chat).toMatchObject({ providerId: 'parent', modelId: 'parent-model' })
  })

  it('starts enabled and toggles per conversation without deleting rules', () => {
    expect(getConversationSubagentProfileRules('c')).toMatchObject({ enabled: true, rules: null })
    expect(setConversationSubagentProfileRules('c', rules).ok).toBe(true)
    const normalizedRules = getConversationSubagentProfileRules('c').rules

    expect(setConversationSubagentProfilesEnabled('c', false)).toMatchObject({
      ok: true,
      value: { enabled: false, rules: normalizedRules },
    })
    expect(getConvUiPrefs('c').chat?.subagentProfiles).toEqual(normalizedRules)

    insertConversation({
      id: 'other',
      workspaceId: 'w',
      name: 'Other',
      branch: 'main',
      mode: 'local',
      experience: 'standard',
      cwd: '/tmp/w',
      status: 'idle',
      createdAt: 2,
      archived: 0,
      pinnedAt: null,
      lastActivityAt: 2,
      isMulti: 0,
    })
    expect(getConversationSubagentProfileRules('other').enabled).toBe(true)

    expect(setConversationSubagentProfilesEnabled('c', true)).toMatchObject({
      ok: true,
      value: { enabled: true, rules: normalizedRules },
    })
    expect(getConvUiPrefs('c').chat?.subagentProfiles).toEqual(normalizedRules)
  })

  it('reads legacy configurations with synthetic efforts but requires replacement before saving again', () => {
    const legacyOff = { version: 1 as const, default: [{ providerId: 'p', modelId: 'm', effort: 'off' }] }
    const legacyMaestrlyUltra = {
      version: 1 as const,
      default: [{ providerId: 'p', modelId: 'm', effort: 'maestrly-ultra' }],
    }
    setAppSetting(SUBAGENT_PROFILES_SETTING_KEY, JSON.stringify(legacyOff))
    expect(getGlobalSubagentProfileRules().rules).toEqual(legacyOff)
    expect(setGlobalSubagentProfileRules(legacyOff).ok).toBe(false)

    patchConvUiPrefs('c', { chat: { ...getConvUiPrefs('c').chat, subagentProfiles: legacyMaestrlyUltra } })
    expect(getConversationSubagentProfileRules('c').rules).toEqual(legacyMaestrlyUltra)
    expect(setConversationSubagentProfileRules('c', legacyMaestrlyUltra).ok).toBe(false)
  })
})
