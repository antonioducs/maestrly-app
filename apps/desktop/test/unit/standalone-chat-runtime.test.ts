import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { insertConversation } from '../../src/main/store'
import { conversationPermissionScope } from '../../src/shared/conversation-scope'
import type { StandaloneConversation } from '../../src/shared/conversation'
import { effectiveSkills } from '../../src/main/chat/skill-state'
import { listEffectiveAgents } from '../../src/main/chat/virtual-subagents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { freshDb, closeDb } from '../helpers/db'
import { buildProjectContext, buildOpenAIProjectContext } from '../../src/main/chat/project-context'
import { PermissionBroker, BYOK_DEFAULT_RULESET } from '../../src/main/chat/permission'
import { getDb } from '../../src/main/store'
beforeEach(freshDb)
afterEach(() => {
  vi.restoreAllMocks()
  closeDb()
})
describe('standalone runtime isolation', () => {
  it('returns before any filesystem discovery for both project context builders', async () => {
    const read = vi.spyOn(fsp, 'readFile')
    const stat = vi.spyOn(fsp, 'stat')
    expect(await buildProjectContext(null, '/private/chat')).toBe('')
    expect(await buildOpenAIProjectContext(null, '/private/chat')).toBe('')
    expect(read).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
  it('saves approvals under the owning conversation without sharing with other chats', async () => {
    const broker = new PermissionBroker({ rulesetFor: () => BYOK_DEFAULT_RULESET })
    const first = broker.assert({
      conversationId: 'chat-a',
      projectId: null,
      action: 'edit',
      resources: ['/x'],
      save: ['*'],
    })
    broker.reply({ requestId: broker.pendingFor('chat-a')[0].id, reply: 'always' })
    await first
    expect(getDb().prepare('SELECT project_id FROM permission_saved').all()).toEqual([
      { project_id: 'conversation:chat-a' },
    ])
    await broker.assert({ conversationId: 'chat-a', projectId: null, action: 'edit', resources: ['/y'] })
    const second = broker.assert({ conversationId: 'chat-b', projectId: null, action: 'edit', resources: ['/y'] })
    expect(broker.pendingFor('chat-b')).toHaveLength(1)
    broker.reply({ requestId: broker.pendingFor('chat-b')[0].id, reply: 'once' })
    await second
  })
})

function standalone(id: string, cwd = '/private/chat'): StandaloneConversation {
  return {
    id,
    scope: 'standalone',
    workspaceId: null,
    branch: null,
    mode: null,
    experience: 'standard',
    isMulti: 0,
    name: id,
    cwd,
    status: 'idle',
    createdAt: 1,
    archived: 0,
    pinnedAt: null,
    lastActivityAt: 1,
  }
}

it('discovers configured global skills and agents without reading the private chat or its ancestors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-catalog-'))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'private', 'chat')
  try {
    for (const [base, name] of [
      [home, 'global'],
      [cwd, 'local'],
      [path.dirname(cwd), 'ancestor'],
    ]) {
      await mkdir(path.join(base, '.agents/skills', name), { recursive: true })
      await writeFile(
        path.join(base, '.agents/skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} skill\n---\nDo ${name}`
      )
      await mkdir(path.join(base, '.agents/agents'), { recursive: true })
      await writeFile(
        path.join(base, '.agents/agents', `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} agent\n---\nDo ${name}`
      )
    }
    insertConversation(standalone('catalog', cwd))
    const read = vi.spyOn(fsp, 'readdir')
    expect((await effectiveSkills(cwd, 'catalog', home)).map((s) => s.name)).toEqual(['global'])
    const agents = await listEffectiveAgents({ cwd, conversationId: 'catalog', home })
    expect(agents.map((a) => a.name)).toContain('global')
    expect(agents.map((a) => a.name)).not.toContain('local')
    expect(agents.map((a) => a.name)).not.toContain('ancestor')
    expect(read.mock.calls.every(([directory]) => String(directory).startsWith(home))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('inherits the owning conversation approval scope in child execution and preserves policy denies', async () => {
  const permissionScope = conversationPermissionScope(standalone('owner'))
  const broker = new PermissionBroker({
    rulesetFor: (id) =>
      id === 'denied-child' ? [{ action: 'edit', resource: '*', effect: 'deny' }] : BYOK_DEFAULT_RULESET,
  })
  const input = { projectId: null, permissionScope, action: 'edit', resources: ['/file'], save: ['*'] }
  const first = broker.assert({ ...input, conversationId: 'owner' })
  broker.reply({ requestId: broker.pendingFor('owner')[0].id, reply: 'always' })
  await first
  await broker.assert({ ...input, conversationId: 'child' })
  await expect(broker.assert({ ...input, conversationId: 'denied-child' })).rejects.toThrow('permission policy')
  expect(getDb().prepare('SELECT project_id FROM permission_saved').all()).toEqual([
    { project_id: 'conversation:owner' },
  ])
})
