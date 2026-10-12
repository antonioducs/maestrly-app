import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  effectiveSkills,
  findEffectiveSkill,
  forgetSkillNames,
  listGloballyDisabledSkills,
  listSkillGroups,
  createSkillGroup,
  listSkillsState,
  setConversationSkillOverride,
  setSkillEnabledGlobal,
} from '../../src/main/chat/skill-state'
import { renderSkillContext } from '../../src/main/chat/skills'
import { setAppPluginLayoutForTests } from '../../src/main/plugins/app-layout'
import { pluginLayout } from '../../src/main/plugins/layout'
import { activePlugins } from '../../src/main/plugins/runtime'
import { writeInstalled } from '../../src/main/plugins/store'
import { normalizeSkillName, parseSlashInvocation } from '../../src/shared/chat'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'
import { codexDemoPlugin, installFixturePlugin } from '../helpers/plugin-install'

vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => true,
  secureGet: () => null,
  secureSet: () => true,
  secureRemove: () => true,
}))

let home: string
const names = (skills: { name: string }[]) => skills.map((s) => s.name)

beforeEach(() => {
  freshDb()
  home = mkdtempSync(path.join(os.tmpdir(), 'plg-home-'))
  setAppPluginLayoutForTests(pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'plg-layout-'))))
})
afterEach(() => {
  setAppPluginLayoutForTests(null)
  closeDb()
})

describe('plugin skill names', () => {
  it('keeps one namespace separator', () => {
    expect(normalizeSkillName('/Figma:Implement Design')).toBe('figma:implement-design')
    // Only the FIRST ':' is kept; later ones are dropped like any other punctuation.
    expect(normalizeSkillName('a:b:c')).toBe('a:bc')
    expect(normalizeSkillName(':x')).toBe('x')
    expect(parseSlashInvocation('/expo:setup ios')).toEqual({ name: 'expo:setup', args: 'ios' })
    expect(parseSlashInvocation('/review now')).toEqual({ name: 'review', args: 'now' })
  })
})

describe('plugin skills in conversations', () => {
  async function setup() {
    const layout = pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'plg-layout-')))
    setAppPluginLayoutForTests(layout)
    const w1 = makeWorkspace()
    const w2 = makeWorkspace()
    const standalone = makeStandaloneConversation()
    const p1 = makeConversation(w1.id)
    const p2 = makeConversation(w2.id)
    await installFixturePlugin(layout, { name: 'demo', files: codexDemoPlugin('demo') })
    await installFixturePlugin(layout, {
      name: 'scoped',
      files: codexDemoPlugin('scoped'),
      scope: { kind: 'projects', workspaceIds: [w1.id] },
    })
    return { standalone, p1, p2 }
  }

  it('exposes a global plugin skill everywhere and a project plugin only in its project', async () => {
    const { standalone, p1, p2 } = await setup()
    expect(names(await effectiveSkills('', standalone.id, home))).toContain('demo:hello')
    expect(names(await effectiveSkills('', standalone.id, home))).not.toContain('scoped:hello')
    expect(names(await effectiveSkills(p1.cwd, p1.id, home))).toEqual(
      expect.arrayContaining(['demo:hello', 'scoped:hello', 'demo:review', 'scoped:review'])
    )
    expect(names(await effectiveSkills(p2.cwd, p2.id, home))).not.toContain('scoped:hello')
    // No conversation: only global plugins. Settings (listSkillsState without a conversation): every plugin.
    expect(names(await effectiveSkills('', undefined, home))).not.toContain('scoped:hello')
    expect(names((await listSkillsState(undefined, home)).skills)).toContain('scoped:hello')
    expect(activePlugins({ conversationId: p2.id }).map((r) => r.name)).toEqual(['demo'])
  })

  it('hides every skill of a disabled plugin', async () => {
    const { p1 } = await setup()
    writeInstalled((all) => {
      all['demo@fixtures'].enabled = false
    })
    expect(names(await effectiveSkills(p1.cwd, p1.id, home))).not.toContain('demo:hello')
  })

  it('honours global disable and conversation overrides for plugin skills', async () => {
    const { p1 } = await setup()
    setSkillEnabledGlobal('demo:hello', false)
    expect(names(await effectiveSkills(p1.cwd, p1.id, home))).not.toContain('demo:hello')
    setConversationSkillOverride(p1.id, 'demo:hello', 'on')
    expect(names(await effectiveSkills(p1.cwd, p1.id, home))).toContain('demo:hello')
    const state = await listSkillsState(p1.id, home)
    expect(state.skills.find((s) => s.name === 'demo:hello')).toMatchObject({
      scope: 'plugin',
      plugin: { key: 'demo@fixtures', displayName: 'demo plugin', kind: 'skill' },
      override: 'on',
    })
  })

  it('renders a plugin command as a user-invocable skill with $ARGUMENTS', async () => {
    const { p1 } = await setup()
    const cmd = await findEffectiveSkill(p1.cwd, p1.id, 'demo:review', home)
    expect(cmd).toMatchObject({ userInvocable: true, modelInvocable: false, scope: 'plugin', argumentHint: '[file]' })
    expect(renderSkillContext(cmd!, { args: 'src/a.ts', invokedBy: 'user' })).toContain('Review src/a.ts carefully.')
    const skill = await findEffectiveSkill(p1.cwd, p1.id, 'demo:hello', home)
    expect(skill?.dir).toMatch(/skills[/\\]hello$/)
    expect(renderSkillContext(skill!)).toContain('Hello from demo.')
  })

  it('disk skills cannot claim a plugin namespace', async () => {
    const { p1 } = await setup()
    mkdirSync(path.join(home, '.agents/skills/x'), { recursive: true })
    writeFileSync(
      path.join(home, '.agents/skills/x/SKILL.md'),
      '---\nname: demo:hello\ndescription: impostor\n---\nNo.'
    )
    const skills = await effectiveSkills(p1.cwd, p1.id, home)
    expect(names(skills)).toContain('demohello')
    expect(skills.find((s) => s.name === 'demo:hello')?.scope).toBe('plugin')
  })

  it('forgets removed plugin skills in disable lists and groups', () => {
    setSkillEnabledGlobal('demo:hello', false)
    setSkillEnabledGlobal('keep', false)
    createSkillGroup({ name: 'Mixed', skills: ['demo:hello', 'keep'] })
    forgetSkillNames(['demo:hello'])
    expect(listGloballyDisabledSkills()).toEqual(['keep'])
    expect(listSkillGroups()[0].skills).toEqual(['keep'])
  })
})

describe('plugin skills through the provider-neutral skill runtime', () => {
  it('lists plugin skills in the catalog and loads them with use_skill', async () => {
    const layout = pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'plg-layout-')))
    setAppPluginLayoutForTests(layout)
    const conversation = makeStandaloneConversation()
    await installFixturePlugin(layout, { name: 'demo', files: codexDemoPlugin('demo') })
    const { buildModelSkillRuntime } = await import('../../src/main/chat/skill-runtime')
    const runtime = await buildModelSkillRuntime({ cwd: '', conversationId: conversation.id, scope: 'standalone' })
    expect(runtime.catalog).toContain('- demo:hello: Say hello from demo')
    // Commands are user-invocable only: never in the model's catalog.
    expect(runtime.catalog).not.toContain('demo:review')
    const loader = runtime.tools.use_skill as unknown as {
      execute: (input: { name: string }, options: { toolCallId: string }) => Promise<string>
    }
    const loaded = await loader.execute({ name: 'demo:hello' }, { toolCallId: 't1' })
    expect(loaded).toContain('Hello from demo.')
    expect(loaded).toContain(path.join('skills', 'hello'))
  })
})
