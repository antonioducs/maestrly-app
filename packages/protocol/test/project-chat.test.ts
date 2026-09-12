import { expect, it } from 'vitest'
import {
  chatCreateSchema,
  chatDecisionSchema,
  chatInventorySchema,
  projectChatMessageSchema,
  projectChatSessionSchema,
} from '../src/project-chat.js'
it('rejects remote global permission and internal messages', () => {
  expect(chatDecisionSchema.safeParse({ type: 'permission', reply: 'always' }).success).toBe(false)
  expect(
    projectChatMessageSchema.safeParse({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: null,
      role: 'system',
      parts: [],
      createdAt: new Date().toISOString(),
    }).success
  ).toBe(false)
  expect(chatInventorySchema.safeParse({ capability: 'executor:codex', enabled: true }).success).toBe(false)
})

it('defaults legacy conversations conservatively and validates configurable chat settings', () => {
  const session = projectChatSessionSchema.parse({
    id: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    ownerUserId: 'owner',
    runnerId: crypto.randomUUID(),
    workspaceKey: 'workspace',
    title: 'Legacy chat',
    model: 'fixture',
    mode: 'chat',
    baseBranch: 'main',
    boardId: null,
    cardId: null,
    version: 1,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  expect(session).toMatchObject({ mode: 'chat', reasoning: null, fastMode: false, permMode: 'ask' })

  expect(
    chatCreateSchema.parse({
      runnerId: crypto.randomUUID(),
      workspaceKey: 'workspace',
      model: 'fixture',
      mode: 'design',
      baseBranch: 'main',
    })
  ).toMatchObject({ mode: 'design', reasoning: null, fastMode: false, permMode: 'ask' })
  expect(
    chatCreateSchema.safeParse({
      runnerId: crypto.randomUUID(),
      workspaceKey: 'workspace',
      model: 'fixture',
      mode: 'agent',
      baseBranch: 'main',
      permMode: 'always',
    }).success
  ).toBe(false)
})

it('accepts enhanced model capabilities while preserving legacy executor inventories', () => {
  const base = {
    capability: 'chat:interactive:v1',
    enabled: true,
    workspaces: [],
    integrations: { memory: false, skills: false, mcp: false },
  }
  const legacy = chatInventorySchema.parse({ ...base, models: [{ id: 'legacy', label: 'Legacy model' }] })
  expect(legacy.models[0]).toMatchObject({ efforts: [], fastMode: false })
  expect(legacy.conversationSettings).toBeUndefined()

  const enhanced = chatInventorySchema.parse({
    ...base,
    models: [
      {
        id: 'codex-model',
        label: 'GPT-5 Codex',
        providerLabel: 'Codex · Work account',
        efforts: ['low', 'high'],
        fastMode: true,
      },
    ],
    conversationSettings: {
      version: 1,
      modes: ['agent', 'plan', 'design', 'ask'],
      permissionModes: ['ask', 'auto', 'full'],
      operatorLimits: { commands: true, web: false, appTools: true, mcp: true, push: false },
    },
  })
  expect(enhanced.models[0]).toMatchObject({ providerLabel: 'Codex · Work account', efforts: ['low', 'high'] })
  expect(enhanced.conversationSettings?.permissionModes).toContain('full')
  expect(enhanced.conversationSettings?.operatorLimits.web).toBe(false)
})
