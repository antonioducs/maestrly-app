import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listEffectiveAgents } from '../../src/main/chat/virtual-subagents'
import { setAppPluginLayoutForTests } from '../../src/main/plugins/app-layout'
import { pluginLayout } from '../../src/main/plugins/layout'
import { listPluginAgents } from '../../src/main/plugins/runtime'
import { writeInstalled } from '../../src/main/plugins/store'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeStandaloneConversation, makeWorkspace } from '../helpers/factories'
import { codexDemoPlugin, installFixturePlugin } from '../helpers/plugin-install'

vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => true,
  secureGet: () => null,
  secureSet: () => true,
  secureRemove: () => true,
}))

const reviewer =
  '---\nname: reviewer\ndescription: Reviews a change\ntools: Read, Grep\nmodel: sonnet\n---\nReview it.\n'
let home: string

beforeEach(() => {
  freshDb()
  home = mkdtempSync(path.join(os.tmpdir(), 'plg-agents-home-'))
})
afterEach(() => {
  setAppPluginLayoutForTests(null)
  closeDb()
})

async function setup() {
  const layout = pluginLayout(mkdtempSync(path.join(os.tmpdir(), 'plg-agents-layout-')))
  setAppPluginLayoutForTests(layout)
  const w1 = makeWorkspace()
  await installFixturePlugin(layout, {
    name: 'demo',
    files: codexDemoPlugin('demo', { 'agents/reviewer.md': reviewer }),
  })
  await installFixturePlugin(layout, {
    name: 'scoped',
    files: codexDemoPlugin('scoped', { 'agents/reviewer.md': reviewer }),
    scope: { kind: 'projects', workspaceIds: [w1.id] },
  })
  return { w1 }
}

describe('plugin agents as subagents', () => {
  it('runs a plugin agent as a namespaced subagent with its mapped tools and no model of its own', async () => {
    await setup()
    const agents = await listPluginAgents({ conversationId: undefined })
    expect(agents.map((agent) => agent.name)).toEqual(['demo-reviewer', 'scoped-reviewer'])
    expect(agents[0]).toEqual({
      name: 'demo-reviewer',
      description: 'Reviews a change',
      tools: ['read', 'grep'],
      prompt: 'Review it.',
      source: 'plugin:demo plugin/agents/reviewer.md',
    })
  })

  it('offers a project plugin’s agents only in its projects, and none of a disabled plugin', async () => {
    const { w1 } = await setup()
    const standalone = makeStandaloneConversation()
    const project = makeConversation(w1.id)
    const names = async (conversationId: string, cwd: string) =>
      (await listEffectiveAgents({ cwd, conversationId, home })).map((agent) => agent.name)
    expect(await names(standalone.id, '')).toContain('demo-reviewer')
    expect(await names(standalone.id, '')).not.toContain('scoped-reviewer')
    expect(await names(project.id, project.cwd)).toEqual(expect.arrayContaining(['demo-reviewer', 'scoped-reviewer']))
    writeInstalled((all) => {
      all['demo@fixtures'].enabled = false
    })
    expect(await names(project.id, project.cwd)).not.toContain('demo-reviewer')
  })

  it('lets an agent file of the project win over a plugin agent with the same name', async () => {
    const { w1 } = await setup()
    const project = makeConversation(w1.id)
    mkdirSync(path.join(project.cwd, '.agents', 'agents'), { recursive: true })
    writeFileSync(
      path.join(project.cwd, '.agents', 'agents', 'demo-reviewer.md'),
      '---\ndescription: Our own reviewer\n---\nOurs.\n'
    )
    const agents = await listEffectiveAgents({ cwd: project.cwd, conversationId: project.id, home })
    const matches = agents.filter((agent) => agent.name === 'demo-reviewer')
    expect(matches).toHaveLength(1)
    expect(matches[0].description).toBe('Our own reviewer')
  })
})
