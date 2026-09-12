import { expect, it } from 'vitest'
import { integrationAvailable } from './helpers.js'
import { chatFixture } from './project-chat-fixture.js'
import { runnerTransaction } from '../../src/modules/project-chat/dispatch.js'
import { chatTransaction, snapshot, updateSession } from '../../src/modules/project-chat/service.js'

it.skipIf(!integrationAvailable)(
  'persists supported settings and rejects legacy, stale, incompatible, and active-turn changes',
  async () => {
    const f = await chatFixture()
    try {
      expect(f.session).toMatchObject({ reasoning: null, fastMode: false, permMode: 'ask' })
      await expect(
        chatTransaction(f.pool, f.scope, true, (c) =>
          updateSession(c, f.scope, f.session.id, { expectedVersion: 1, permMode: 'full' })
        )
      ).rejects.toThrow(/does not support configurable chat settings/)

      await runnerTransaction(f.pool, f.identity, (c) =>
        c.query('update runners set chat_capabilities=$2 where id=$1', [
          f.identity.runnerId,
          {
            capability: 'chat:interactive:v1',
            enabled: true,
            workspaces: [{ key: 'local', projectId: f.scope.projectId, label: 'Fixture', branches: ['main'] }],
            models: [
              {
                id: 'fixture',
                label: 'Fixture model',
                providerLabel: 'Fixture · Work account',
                efforts: ['low', 'high'],
                fastMode: true,
              },
              { id: 'plain', label: 'Plain model', efforts: [], fastMode: false },
            ],
            conversationSettings: {
              version: 1,
              modes: ['agent', 'ask'],
              permissionModes: ['ask', 'auto', 'full'],
              operatorLimits: { commands: true, web: true, appTools: true, mcp: true, push: false },
            },
            integrations: { memory: true, skills: true, mcp: true },
          },
        ])
      )

      const updated = await chatTransaction(f.pool, f.scope, true, (c) =>
        updateSession(c, f.scope, f.session.id, {
          expectedVersion: 1,
          model: 'fixture',
          mode: 'ask',
          reasoning: 'high',
          fastMode: true,
          permMode: 'full',
        })
      )
      expect(updated).toMatchObject({
        version: 2,
        model: 'fixture',
        mode: 'ask',
        reasoning: 'high',
        fastMode: true,
        permMode: 'full',
      })
      expect((await snapshot(f.pool, f.scope, f.session.id)).session).toMatchObject(updated)

      await expect(
        chatTransaction(f.pool, f.scope, true, (c) =>
          updateSession(c, f.scope, f.session.id, { expectedVersion: 1, mode: 'plan' })
        )
      ).rejects.toThrow(/changed/)
      await expect(
        chatTransaction(f.pool, f.scope, true, (c) =>
          updateSession(c, f.scope, f.session.id, {
            expectedVersion: 2,
            model: 'plain',
            reasoning: 'high',
            fastMode: true,
          })
        )
      ).rejects.toThrow(/reasoning effort|Fast mode/)

      await f.send('Keep these settings stable')
      await expect(
        chatTransaction(f.pool, f.scope, true, (c) =>
          updateSession(c, f.scope, f.session.id, { expectedVersion: 2, permMode: 'auto' })
        )
      ).rejects.toThrow(/active turn/)
    } finally {
      await f.pool.end()
    }
  }
)
