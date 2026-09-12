import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { setAppSetting } from '../../src/main/store'
import {
  conversationSkillSelection,
  conversationSkillOverrides,
  createSkillGroup,
  effectiveSkills,
  findEffectiveSkill,
  listGloballyDisabledSkills,
  listSkillGroups,
  listSkillInfos,
  listSkillsState,
  readSkillDetail,
  removeSkillGroup,
  resetConversationSkillOverrides,
  setConversationSkillSelection,
  setConversationSkillOverride,
  setSkillEnabledGlobal,
  skillIsEnabledForSelection,
  updateSkillGroup,
} from '../../src/main/chat/skill-state'

/**
 * Skill enablement combines global settings and conversation overrides.
 * All four providers share effectiveSkills; the final test
 * ensures throughout the CORPUS that no runner calls raw listSkills, which would ignore disabling.
 */
let home = ''
let cwd = ''

const mkSkill = (root: string, folder: string, content: string) => {
  mkdirSync(path.join(root, '.agents/skills', folder), { recursive: true })
  writeFileSync(path.join(root, '.agents/skills', folder, 'SKILL.md'), content)
}

beforeEach(() => {
  freshDb()
  workspaceId = ''
  home = mkdtempSync(path.join(os.tmpdir(), 'skill-state-home-'))
  cwd = mkdtempSync(path.join(os.tmpdir(), 'skill-state-cwd-'))
})
afterEach(() => {
  closeDb()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

let workspaceId = ''
function chatConversation() {
  // Use one unique workspace per test with multiple conversations sharing cwd.
  if (!workspaceId) workspaceId = makeWorkspace({ path: cwd }).id
  return makeConversation(workspaceId, { cwd })
}

describe('global state and per-conversation overrides', () => {
  it('global disabling removes the skill from effectiveSkills and use_skill through findEffectiveSkill', async () => {
    mkSkill(cwd, 'deploy', '---\nname: deploy\ndescription: deploys\n---\nbody')
    mkSkill(cwd, 'review', '---\nname: review\ndescription: reviews\n---\nbody')
    const conv = chatConversation()

    expect((await effectiveSkills(cwd, conv.id, home)).map((s) => s.name).sort()).toEqual(['deploy', 'review'])

    setSkillEnabledGlobal('deploy', false)
    expect(listGloballyDisabledSkills()).toEqual(['deploy'])
    expect((await effectiveSkills(cwd, conv.id, home)).map((s) => s.name)).toEqual(['review'])
    expect(await findEffectiveSkill(cwd, conv.id, 'deploy', home)).toBeNull()

    setSkillEnabledGlobal('deploy', true)
    expect(await findEffectiveSkill(cwd, conv.id, 'deploy', home)).not.toBeNull()
  })

  it('applies conversation skill overrides over global state', async () => {
    mkSkill(cwd, 'deploy', '---\nname: deploy\n---\nbody')
    mkSkill(cwd, 'review', '---\nname: review\n---\nbody')
    const a = chatConversation()
    const b = chatConversation()

    setSkillEnabledGlobal('deploy', false)
    setConversationSkillOverride(a.id, 'deploy', 'on') // Re-enabled ONLY in conversation A.
    setConversationSkillOverride(b.id, 'review', 'off') // Disabled ONLY in conversation B.

    expect((await effectiveSkills(cwd, a.id, home)).map((s) => s.name).sort()).toEqual(['deploy', 'review'])
    expect((await effectiveSkills(cwd, b.id, home)).map((s) => s.name)).toEqual([])
    expect(conversationSkillOverrides(a.id)).toEqual({ deploy: 'on' })

    setConversationSkillOverride(a.id, 'deploy', 'inherit') // Inherits the disabled global state again.
    expect(conversationSkillOverrides(a.id)).toEqual({})
    expect((await effectiveSkills(cwd, a.id, home)).map((s) => s.name)).toEqual(['review'])
  })

  it('uses global skills when conversation IDs are absent', async () => {
    mkSkill(home, 'global-skill', '---\nname: global-skill\n---\nbody')
    expect((await effectiveSkills('', undefined, home)).map((s) => s.name)).toEqual(['global-skill'])
    setSkillEnabledGlobal('global-skill', false)
    expect(await effectiveSkills('', undefined, home)).toEqual([])
  })
})

describe('global skill groups and conversation selection', () => {
  it('validates persisted JSON while preserving valid missing members', () => {
    setAppSetting(
      'chat.skills.groups.v1',
      JSON.stringify([
        null,
        { id: '', name: 'no id', skills: [] },
        { id: 'g1', name: ' Backend ', description: '  APIs   Go ', skills: ['Go Style', 'go-style', 42, 'missing'] },
        { id: 'g2', name: 'backend', skills: ['duplicate by name'] },
        { id: 'g1', name: 'another duplicate id', skills: [] },
      ])
    )
    expect(listSkillGroups()).toEqual([
      { id: 'g1', name: 'Backend', description: 'APIs Go', skills: ['go-style', 'missing'] },
    ])
  })

  it('supports stable group IDs and normalized unique names and members', () => {
    expect(createSkillGroup({ name: '   ' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(
      createSkillGroup({ name: 'Grande demais', skills: Array.from({ length: 501 }, (_, index) => `s-${index}`) })
    ).toEqual({ ok: false, error: 'too-many-skills' })
    const created = createSkillGroup({
      name: '  Golang   Backend  ',
      description: '  APIs   in Go  ',
      skills: ['Go Style', '/go-style', 'missing-skill', ''],
    })
    expect(created).toMatchObject({
      ok: true,
      group: {
        name: 'Golang Backend',
        description: 'APIs in Go',
        skills: ['go-style', 'missing-skill'],
      },
    })
    const id = created.group?.id ?? ''
    expect(id).not.toBe('')
    expect(createSkillGroup({ name: 'golang backend' })).toEqual({ ok: false, error: 'duplicate-name' })

    expect(updateSkillGroup(id, { name: 'Go Services', skills: ['go-style', 'go-errors', 'go-style'] })).toMatchObject({
      ok: true,
      group: { id, name: 'Go Services', skills: ['go-style', 'go-errors'] },
    })
    expect(listSkillGroups()).toEqual([
      expect.objectContaining({ id, name: 'Go Services', skills: ['go-style', 'go-errors'] }),
    ])
    expect(updateSkillGroup(id, { name: '   ' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(removeSkillGroup(id)).toEqual({ ok: true })
    expect(listSkillGroups()).toEqual([])
  })

  it('resolves global and conversation skill precedence', async () => {
    mkSkill(cwd, 'go-style', '---\nname: go-style\n---\nbody')
    mkSkill(cwd, 'go-errors', '---\nname: go-errors\n---\nbody')
    mkSkill(cwd, 'react', '---\nname: react\n---\nbody')
    const conv = chatConversation()
    const group = createSkillGroup({ name: 'Golang Backend', skills: ['go-style', 'go-errors', 'missing'] }).group!

    expect(conversationSkillSelection(conv.id)).toEqual({ kind: 'all' }) // Legacy conversation compatibility.
    expect(setConversationSkillSelection(conv.id, { kind: 'group', groupId: 'missing-group' })).toEqual({
      ok: false,
      error: 'group-not-found',
    })
    expect(conversationSkillSelection(conv.id)).toEqual({ kind: 'all' })
    setConversationSkillOverride(conv.id, 'react', 'off')
    expect(setConversationSkillSelection(conv.id, { kind: 'group', groupId: group.id })).toEqual({ ok: true })
    expect(conversationSkillOverrides(conv.id)).toEqual({}) // Switching groups atomically clears overrides.
    expect((await effectiveSkills(cwd, conv.id, home)).map((skill) => skill.name).sort()).toEqual([
      'go-errors',
      'go-style',
    ])

    setSkillEnabledGlobal('go-errors', false)
    expect((await effectiveSkills(cwd, conv.id, home)).map((skill) => skill.name)).toEqual(['go-style'])
    setConversationSkillOverride(conv.id, 'go-errors', 'on') // on re-enables even a globally disabled skill.
    setConversationSkillOverride(conv.id, 'go-style', 'off')
    setConversationSkillOverride(conv.id, 'react', 'on') // A skill outside the group becomes an override.
    expect((await effectiveSkills(cwd, conv.id, home)).map((skill) => skill.name).sort()).toEqual([
      'go-errors',
      'react',
    ])
    expect(resetConversationSkillOverrides(conv.id)).toEqual({ ok: true })
    expect((await effectiveSkills(cwd, conv.id, home)).map((skill) => skill.name)).toEqual(['go-style'])

    expect(setConversationSkillSelection(conv.id, { kind: 'none' })).toEqual({ ok: true })
    expect(await effectiveSkills(cwd, conv.id, home)).toEqual([])
    expect(setConversationSkillSelection(conv.id, { kind: 'all' })).toEqual({ ok: true })
    expect((await effectiveSkills(cwd, conv.id, home)).map((skill) => skill.name).sort()).toEqual(['go-style', 'react'])
  })

  it('resolves removed active groups to none while preserving orphan selection', async () => {
    mkSkill(cwd, 'go-style', '---\nname: go-style\n---\nbody')
    const conv = chatConversation()
    const group = createSkillGroup({ name: 'Temporary', skills: ['go-style'] }).group!
    expect(setConversationSkillSelection(conv.id, { kind: 'group', groupId: group.id })).toEqual({ ok: true })
    expect(await findEffectiveSkill(cwd, conv.id, 'go-style', home)).not.toBeNull()

    removeSkillGroup(group.id)
    expect(conversationSkillSelection(conv.id)).toEqual({ kind: 'group', groupId: group.id })
    expect(await effectiveSkills(cwd, conv.id, home)).toEqual([])
    expect(await listSkillsState(conv.id, home)).toMatchObject({
      selection: { kind: 'group', groupId: group.id },
      selectedGroupMissing: true,
    })
  })

  it('distinguishes base, multiple membership, missing and exception metadata', async () => {
    mkSkill(cwd, 'go-style', '---\nname: go-style\n---\nbody')
    const conv = chatConversation()
    const backend = createSkillGroup({ name: 'Backend', skills: ['go-style', 'missing'] }).group!
    const quality = createSkillGroup({ name: 'Quality', skills: ['go-style'] }).group!
    setConversationSkillSelection(conv.id, { kind: 'group', groupId: backend.id })
    setConversationSkillOverride(conv.id, 'go-style', 'off')

    const state = await listSkillsState(conv.id, home)
    expect(state.skills[0]).toMatchObject({
      name: 'go-style',
      enabled: false,
      baseEnabled: true,
      override: 'off',
      inSelectedGroup: true,
      groupIds: [backend.id, quality.id],
    })
    expect(state.groups[0].skills).toContain('missing') // Missing members are not discarded.
    expect(skillIsEnabledForSelection('outside', new Set(), { kind: 'none' }, state.groups, { outside: 'on' })).toBe(
      true
    )
  })
})

describe('UI listings', () => {
  it('hasOverrides considers only overrides for skills that still exist', async () => {
    const conv = chatConversation()
    setConversationSkillOverride(conv.id, 'removida', 'on')

    expect(conversationSkillOverrides(conv.id)).toEqual({ removida: 'on' })
    expect((await listSkillsState(conv.id, home)).hasOverrides).toBe(false)

    mkSkill(cwd, 'deploy', '---\nname: deploy\n---\nbody')
    setConversationSkillOverride(conv.id, 'deploy', 'off')
    expect((await listSkillsState(conv.id, home)).hasOverrides).toBe(true)
  })

  it('lists disabled skills with effective state', async () => {
    mkSkill(cwd, 'deploy', '---\nname: deploy\ndescription: deploys\n---\nbody')
    const conv = chatConversation()
    setSkillEnabledGlobal('deploy', false)
    setConversationSkillOverride(conv.id, 'deploy', 'on')

    const infos = await listSkillInfos(conv.id, home)
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      name: 'deploy',
      enabled: true, // override 'on' vence
      enabledGlobally: false,
      override: 'on',
      scope: 'project',
      resources: { scripts: 0, references: 0, assets: 0 },
    })
  })

  it('returns skill bodies and packaged files', async () => {
    mkSkill(cwd, 'pack', '---\nname: pack\n---\ninstructions')
    mkdirSync(path.join(cwd, '.agents/skills/pack/scripts'), { recursive: true })
    writeFileSync(path.join(cwd, '.agents/skills/pack/scripts/run.sh'), 'echo ok')
    const conv = chatConversation()

    const detail = await readSkillDetail('pack', conv.id, home)
    expect(detail).toMatchObject({ name: 'pack', body: 'instructions', files: ['scripts/run.sh'] })
    expect(await readSkillDetail('missing', conv.id, home)).toBeNull()
  })
})

describe('skill consumer contracts', () => {
  it('all four runners resolve skills through effectiveSkills and never raw listSkills', () => {
    const root = fileURLToPath(new URL('../../src/main/chat/', import.meta.url))
    const runners = [
      'runner.ts',
      'claude-agent-sdk/runner.ts',
      'github-copilot/runner.ts',
      'codex-subscription/runner.ts',
    ]
    for (const file of runners) {
      const source = readFileSync(path.join(root, file), 'utf8')
      expect(source, file).toContain('effectiveSkills')
      expect(source, file).not.toMatch(/\blistSkills\(/)
    }
    // The slash palette also resolves effective skills.
    const service = readFileSync(path.join(root, 'service.ts'), 'utf8')
    expect(service).toContain('effectiveSkills')
    expect(service).not.toMatch(/\blistSkills\(/)
    // Verify runner source files actually exist at expected paths.
    expect(readdirSync(root)).toContain('skill-state.ts')
  })
})
