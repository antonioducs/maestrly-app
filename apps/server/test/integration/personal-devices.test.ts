import { describe, it, expect } from 'vitest'
import { columnAutomationSchema } from '@maestrly/protocol'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createCard, moveCard } from '../../src/modules/cards/service.js'
import { saveColumnAutomation } from '../../src/modules/automation/column-service.js'
import { requestColumnAgent } from '../../src/modules/automation/dispatch.js'
import { claimJob } from '../../src/modules/jobs/claim.js'
import { createRunnerEnrollment, enrollRunner, listProjectRunners } from '../../src/modules/runners/service.js'
import {
  registerPersonalDevice,
  listPersonalDevices,
  disablePersonalDevice,
  personalDevicePresence,
} from '../../src/modules/runners/personal-devices.js'
import { teamTransaction } from '../../src/modules/access/team.js'
import { renewLease } from '../../src/modules/jobs/service.js'

const capabilities = {
  version: 1 as const,
  models: [{ provider: 'codex' as const, model: 'fixture', label: 'Fixture', efforts: ['high'], fastMode: false }],
  maestro: true,
  subagents: true,
  preCommands: false,
  issues: [],
}
describe.skipIf(!integrationAvailable)('personal execution devices', () => {
  it('delivers one atomic move only to its owner device, never the shared pool or another personal machine', async () => {
    const pool = runtimePool()
    try {
      const owner = 'owner-' + crypto.randomUUID(),
        dev = 'dev-' + crypto.randomUUID(),
        other = 'other-' + crypto.randomUUID()
      const organizationId = await seedOrganization('Personal devices', owner)
      const p = await createProject(pool, { organizationId, actorUserId: owner, name: 'Personal execution' }),
        projectId = p.project.id
      const scope = { organizationId, projectId, userId: owner }
      await teamTransaction(pool, scope, async (c) => {
        for (const user of [dev, other]) {
          await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
            organizationId,
            user,
          ])
          await c.query(
            "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'contributor')",
            [organizationId, projectId, user]
          )
        }
      })
      const registered = await registerPersonalDevice(pool, {
        organizationId,
        userId: dev,
        projectIds: [projectId],
        name: 'Dev laptop',
      })
      const second = await registerPersonalDevice(pool, {
        organizationId,
        userId: other,
        projectIds: [projectId],
        name: 'Other laptop',
      })
      const device = { organizationId, ...registered, protocolVersion: '1.0', automationCapabilities: capabilities }
      const stranger = { organizationId, ...second, protocolVersion: '1.0', automationCapabilities: capabilities }
      expect(await claimJob(pool, device)).toBeNull()
      expect(await claimJob(pool, stranger)).toBeNull()
      expect((await listPersonalDevices(pool, { organizationId, projectId, userId: dev })).map((r) => r.id)).toEqual([
        registered.runnerId,
      ])
      expect(await listProjectRunners(pool, scope)).toEqual([])
      const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
      const shared = await enrollRunner(pool, {
        organizationId,
        token: enrollment.token,
        name: 'Team runner',
        protocolVersion: '1.0',
        capabilities: [],
        maxConcurrency: 1,
      })
      const sharedIdentity = { organizationId, ...shared, protocolVersion: '1.0', automationCapabilities: capabilities }
      await claimJob(pool, sharedIdentity)
      const board = await getBoard(pool, { organizationId, userId: dev, boardId: p.boardId }),
        column = board.columns[1]!
      const policy = await saveColumnAutomation(pool, {
        organizationId,
        userId: owner,
        columnId: column.id,
        expectedPolicyId: null,
        config: columnAutomationSchema.parse({
          enabled: true,
          autoRun: true,
          provider: 'codex',
          model: 'fixture',
          approvalRequired: false,
          runnerSelector: 'runner',
          targetRunnerId: shared.runnerId,
        }),
      })
      const card = await createCard(pool, {
        organizationId,
        userId: dev,
        boardId: p.boardId,
        columnId: board.columns[0]!.id,
        title: 'Local work',
      })
      const move = {
        expectedVersion: card.version,
        targetColumnId: column.id,
        targetPosition: 0,
        source: 'human' as const,
        allowAutomationChain: false,
        chainDepth: 0,
        personalExecution: {
          deviceId: registered.runnerId,
          expectedPolicyId: policy.policyId,
          expectedOverrideVersion: 0,
        },
      }
      await expect(moveCard(pool, { organizationId, userId: other, cardId: card.id, move })).rejects.toThrow(/device/i)
      expect(
        (await getBoard(pool, { organizationId, userId: dev, boardId: p.boardId })).cards.find((c) => c.id === card.id)
          ?.columnId
      ).toBe(card.columnId)
      const moved = await moveCard(pool, { organizationId, userId: dev, cardId: card.id, move })
      expect(moved.jobId).toBeTruthy()
      expect(
        (await teamTransaction(pool, scope, (c) => c.query('select id from jobs where card_id=$1', [card.id]))).rowCount
      ).toBe(1)
      expect(await claimJob(pool, sharedIdentity)).toBeNull()
      expect(await claimJob(pool, stranger)).toBeNull()
      const claim = await claimJob(pool, device)
      expect(claim?.envelope.snapshot.personalDevice).toEqual({
        deviceId: registered.runnerId,
        ownerUserId: dev,
        name: 'Dev laptop',
      })
      expect(claim?.envelope.snapshot.targetRunnerId).toBe(registered.runnerId)
      await teamTransaction(pool, scope, (c) =>
        c.query('delete from project_members where user_id=$1 and project_id=$2', [dev, projectId])
      )
      expect(
        await renewLease(pool, {
          organizationId,
          runnerId: registered.runnerId,
          runId: claim!.envelope.runId,
          leaseId: claim!.envelope.leaseId,
        })
      ).toMatchObject({ cancellationRequested: true })
    } finally {
      await pool.end()
    }
  })
})

async function personalFixture() {
  const pool = runtimePool(),
    userId = 'dev-' + crypto.randomUUID(),
    organizationId = await seedOrganization('Personal fixture', userId)
  const project = await createProject(pool, { organizationId, actorUserId: userId, name: 'Local work' }),
    projectId = project.project.id
  const scope = { organizationId, projectId, userId }
  const device = await registerPersonalDevice(pool, {
    organizationId,
    userId,
    projectIds: [projectId],
    name: 'My computer',
  })
  const identity = {
    organizationId,
    runnerId: device.runnerId,
    credential: device.credential!,
    protocolVersion: '1.0',
    automationCapabilities: capabilities,
  }
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId, projectIds: [projectId] })
  const shared = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Shared',
    protocolVersion: '1.0',
    capabilities: [],
    maxConcurrency: 1,
  })
  const sharedIdentity = { organizationId, ...shared, protocolVersion: '1.0', automationCapabilities: capabilities }
  await claimJob(pool, identity)
  await claimJob(pool, sharedIdentity)
  const board = await getBoard(pool, { organizationId, userId, boardId: project.boardId }),
    column = board.columns[1]!
  const policy = await saveColumnAutomation(pool, {
    organizationId,
    userId,
    columnId: column.id,
    expectedPolicyId: null,
    config: columnAutomationSchema.parse({ enabled: true, autoRun: true, model: 'fixture', approvalRequired: false }),
  })
  const card = await createCard(pool, {
    organizationId,
    userId,
    boardId: project.boardId,
    columnId: column.id,
    title: 'My task',
  })
  const request = {
    organizationId,
    userId,
    cardId: card.id,
    expectedVersion: card.version,
    expectedPolicyId: policy.policyId,
    expectedOverrideVersion: 0,
    personalDeviceId: device.runnerId,
  }
  return { pool, scope, device, identity, sharedIdentity, board, column, policy, card, request }
}
describe.skipIf(!integrationAvailable)('personal device availability and fences', () => {
  it('waits for the exact offline device, refuses paused devices and never consumes shared jobs', async () => {
    const f = await personalFixture()
    try {
      await f.pool.query('select 1')
      await teamTransaction(f.pool, f.scope, (c) =>
        c.query("update runners set last_seen_at=now()-interval '2 minutes' where id=$1", [f.device.runnerId])
      )
      expect((await listPersonalDevices(f.pool, f.scope))[0]).toMatchObject({ online: false, enabled: true })
      const queued = await requestColumnAgent(f.pool, f.request)
      expect(queued.jobId).toBeTruthy()
      expect(await claimJob(f.pool, f.sharedIdentity)).toBeNull()
      const claimed = await claimJob(f.pool, f.identity)
      expect(claimed?.envelope.jobId).toBe(queued.jobId)
      await teamTransaction(f.pool, f.scope, async (c) => {
        await c.query("update runs set state='succeeded' where id=$1", [claimed!.envelope.runId])
        await c.query("update jobs set state='completed' where id=$1", [queued.jobId])
      })
      await personalDevicePresence(f.pool, { ...f.identity, online: false })
      await expect(requestColumnAgent(f.pool, f.request)).rejects.toThrow(/device/i)
      expect(await claimJob(f.pool, f.identity)).toBeNull()
      await registerPersonalDevice(f.pool, {
        ...f.scope,
        projectIds: [f.scope.projectId],
        name: 'My computer',
        deviceId: f.device.runnerId,
      })
      const shared = await requestColumnAgent(f.pool, { ...f.request, personalDeviceId: undefined })
      expect(shared.jobId).toBeTruthy()
      expect(await claimJob(f.pool, f.identity)).toBeNull()
      expect((await claimJob(f.pool, f.sharedIdentity))?.envelope.jobId).toBe(shared.jobId)
    } finally {
      await f.pool.end()
    }
  })
  it('rejects stale confirmations, excludes viewers and revokes only the owner device with pending work', async () => {
    const f = await personalFixture()
    try {
      await expect(requestColumnAgent(f.pool, { ...f.request, expectedOverrideVersion: 1 })).rejects.toThrow(
        /override changed/
      )
      await expect(requestColumnAgent(f.pool, { ...f.request, expectedVersion: 100 })).rejects.toThrow()
      const viewer = 'viewer-' + crypto.randomUUID()
      await teamTransaction(f.pool, f.scope, async (c) => {
        await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
          f.scope.organizationId,
          viewer,
        ])
        await c.query(
          "insert into project_members(organization_id,project_id,user_id,role) values($1,$2,$3,'viewer')",
          [f.scope.organizationId, f.scope.projectId, viewer]
        )
      })
      await expect(
        registerPersonalDevice(f.pool, { ...f.scope, userId: viewer, projectIds: [f.scope.projectId], name: 'Viewer' })
      ).rejects.toThrow(/authorized/)
      await expect(
        disablePersonalDevice(f.pool, { ...f.scope, userId: viewer, deviceId: f.device.runnerId })
      ).rejects.toThrow(/device/i)
      await expect(
        registerPersonalDevice(f.pool, {
          ...f.scope,
          projectIds: [f.scope.projectId],
          name: 'Hijack',
          deviceId: f.sharedIdentity.runnerId,
        })
      ).rejects.toThrow(/device/i)
      const queued = await requestColumnAgent(f.pool, f.request)
      await disablePersonalDevice(f.pool, { ...f.scope, deviceId: f.device.runnerId })
      expect(
        (await teamTransaction(f.pool, f.scope, (c) => c.query('select state from jobs where id=$1', [queued.jobId])))
          .rows[0].state
      ).toBe('cancelled')
      await expect(claimJob(f.pool, f.identity)).rejects.toThrow(/revoked/)
      expect(await claimJob(f.pool, f.sharedIdentity)).toBeNull()
      expect(await listPersonalDevices(f.pool, f.scope)).toEqual([])
    } finally {
      await f.pool.end()
    }
  })
})
