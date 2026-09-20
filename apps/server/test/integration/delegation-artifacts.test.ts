import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { delegationCatalogRevision, delegationModelCatalogSchema, type DelegationModelCatalog } from '@maestrly/protocol'
import { inTenantTransaction } from '../../src/db/transaction.js'
import {
  appendArtifactChunk,
  completeArtifactUpload,
  listDelegationArtifacts,
  purgeExpiredArtifactUploads,
  readDelegationArtifact,
  startArtifactUpload,
  MAX_CHUNK_BYTES,
} from '../../src/modules/delegations/artifacts.js'
import { listCheckConfigs, recordCheckResult, requiredCheckGaps, saveCheckConfig } from '../../src/modules/delegations/checks.js'
import { publishDelegationCatalog } from '../../src/modules/delegations/model-catalog.js'
import { claimInspection, completeInspection, getInspection, startInspection } from '../../src/modules/delegations/inspections.js'
import { loadTaskRow } from '../../src/modules/delegations/repository.js'
import { createDelegation } from '../../src/modules/delegations/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { getBoard } from '../../src/modules/boards/service.js'
import { createRunnerEnrollment, enrollRunner } from '../../src/modules/runners/service.js'
import { teamTransaction } from '../../src/modules/access/team.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

const links = { webOrigin: 'http://127.0.0.1:4173' }
let storage = ''

beforeEach(() => {
  storage = mkdtempSync(path.join(os.tmpdir(), 'delegation-artifacts-'))
})
afterEach(() => {
  if (storage) rmSync(storage, { recursive: true, force: true })
  storage = ''
})

const features = (browserInteract = false) => ({
  checks: [{ id: 'unit', label: 'Unit tests', description: '', required: true, mutatesWorkspace: false }],
  github: { available: false, login: null, issue: null },
  preview: { available: true, issue: null },
  maestro: true,
  subagents: false,
  browserInspect: true,
  browserInteract,
})

function catalogFor(projectId: string, browserInteract = false): DelegationModelCatalog {
  const models = [
    {
      selectionId: 'sel-opus',
      modelLabel: 'claude-opus-5',
      accountLabel: 'Claude · personal',
      efforts: ['high'],
      fastMode: false,
      executionModes: ['standard'],
      delegationProfiles: [],
      harnessProfileId: null,
      harnessHash: null,
    },
  ]
  const workspaces = [
    { projectId, key: 'workspace-key', label: 'Repo', branches: ['main'], repositoryBindingId: null },
  ]
  return delegationModelCatalogSchema.parse({
    capability: 'delegation:stages:v1',
    enabled: true,
    revision: delegationCatalogRevision({ models: models as never, features: features(browserInteract), workspaces }),
    generatedAt: new Date().toISOString(),
    workspaces,
    models,
    features: features(browserInteract),
    issues: [],
  })
}

async function fixture(pool: ReturnType<typeof runtimePool>, name: string, options: { browserInteract?: boolean; previewInteract?: boolean } = {}) {
  const owner = 'evid-owner-' + crypto.randomUUID()
  const organizationId = await seedOrganization(name, owner)
  const project = await createProject(pool, { organizationId, actorUserId: owner, name })
  const projectId = project.project.id
  const enrollment = await createRunnerEnrollment(pool, { organizationId, userId: owner, projectIds: [projectId] })
  const executor = await enrollRunner(pool, {
    organizationId,
    token: enrollment.token,
    name: 'Executor',
    protocolVersion: '1.0',
    capabilities: [{ name: 'executor:maestrly' }],
    maxConcurrency: 2,
  })
  await inTenantTransaction(pool, { organizationId, actor: { type: 'runner', runnerId: executor.runnerId } }, (client) =>
    publishDelegationCatalog(client, {
      organizationId,
      runnerId: executor.runnerId,
      catalog: catalogFor(projectId, options.browserInteract ?? false),
    })
  )
  const board = await getBoard(pool, { organizationId, userId: owner, boardId: project.boardId })
  const scope = { organizationId, projectId, userId: owner }
  const view = await createDelegation(
    pool,
    scope,
    {
      boardId: board.board.id,
      title: name,
      objective: '',
      acceptanceCriteria: [],
      executorId: executor.runnerId,
      workspaceKey: 'workspace-key',
      baseBranch: 'main',
      ...(options.previewInteract ? { policy: { autonomy: { previewInteract: true } } } : {}),
      stages: [
        {
          type: 'implement',
          title: 'Implement',
          instructions: '',
          dependsOn: [],
          requiredForCompletion: true,
          settings: { selectionId: 'sel-opus', reasoning: 'high' },
        },
      ],
      dependsOnTaskIds: [],
      start: false,
    },
    links
  )
  return { owner, organizationId, projectId, executorId: executor.runnerId, scope, taskId: view.task.id }
}

const limits = { maxArtifactBytes: 4 * MAX_CHUNK_BYTES, maxTaskBytes: 6 * MAX_CHUNK_BYTES }

describe.skipIf(!integrationAvailable)('delegation evidence', () => {
  it('stores an artifact only after the declared digest is verified', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Evidence upload')
      const bytes = Buffer.from('a'.repeat(3000))
      const digest = createHash('sha256').update(bytes).digest('hex')
      const uploadContext = {
        organizationId: context.organizationId,
        projectId: context.projectId,
        taskId: context.taskId,
        runnerId: context.executorId,
        storageDirectory: storage,
        limits,
      }
      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      const started = await inTenantTransaction(pool, runner, (client) =>
        startArtifactUpload(client, uploadContext, {
          kind: 'log',
          name: 'unit.log',
          contentType: 'text/plain',
          sizeBytes: bytes.byteLength,
        })
      )
      await inTenantTransaction(pool, runner, (client) =>
        appendArtifactChunk(client, uploadContext, started.uploadId, {
          index: 0,
          contentBase64: bytes.subarray(0, 1500).toString('base64'),
        })
      )
      // An out-of-order chunk is refused rather than silently reordered.
      await expect(
        inTenantTransaction(pool, runner, (client) =>
          appendArtifactChunk(client, uploadContext, started.uploadId, {
            index: 5,
            contentBase64: bytes.subarray(1500).toString('base64'),
          })
        )
      ).rejects.toThrow(/Out-of-order chunk/)
      await inTenantTransaction(pool, runner, (client) =>
        appendArtifactChunk(client, uploadContext, started.uploadId, {
          index: 1,
          contentBase64: bytes.subarray(1500).toString('base64'),
        })
      )
      // A wrong digest never becomes an artifact.
      await expect(
        inTenantTransaction(pool, runner, (client) =>
          completeArtifactUpload(client, uploadContext, started.uploadId, 'f'.repeat(64))
        )
      ).rejects.toThrow(/does not match the declared digest/)

      const second = await inTenantTransaction(pool, runner, (client) =>
        startArtifactUpload(client, uploadContext, {
          kind: 'log',
          name: 'unit.log',
          contentType: 'text/plain',
          sizeBytes: bytes.byteLength,
        })
      )
      await inTenantTransaction(pool, runner, (client) =>
        appendArtifactChunk(client, uploadContext, second.uploadId, { index: 0, contentBase64: bytes.toString('base64') })
      )
      const artifact = await inTenantTransaction(pool, runner, (client) =>
        completeArtifactUpload(client, uploadContext, second.uploadId, digest)
      )
      expect(artifact.digest).toBe(digest)
      expect(artifact.sizeBytes).toBe(bytes.byteLength)

      const listed = await listDelegationArtifacts(pool, context.scope, context.taskId)
      expect(listed.map((item) => item.id)).toEqual([artifact.id])
      const read = await readDelegationArtifact(pool, context.scope, {
        taskId: context.taskId,
        artifactId: artifact.id,
        storageDirectory: storage,
      })
      expect(read.bytes.equals(bytes)).toBe(true)
      // An oversized request is refused before a byte is accepted.
      await expect(
        inTenantTransaction(pool, runner, (client) =>
          startArtifactUpload(client, uploadContext, {
            kind: 'log',
            name: 'huge.log',
            contentType: 'text/plain',
            sizeBytes: limits.maxArtifactBytes + 1,
          })
        )
      ).rejects.toThrow(/above the/)
      // Incomplete uploads expire and leave nothing behind.
      await inTenantTransaction(pool, runner, (client) =>
        client.query(
          "update delegation_artifact_uploads set expires_at = now() - interval '1 minute' where organization_id=$1",
          [context.organizationId]
        )
      )
      expect(await purgeExpiredArtifactUploads(pool, storage)).toBeGreaterThan(0)
    } finally {
      await pool.end()
    }
  })

  it('keeps a check result bound to its revision and refuses a contradictory one', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Evidence checks')
      const config = await saveCheckConfig(pool, context.scope, {
        id: 'unit',
        label: 'Unit tests',
        description: '',
        command: 'npm',
        args: ['test'],
        workingDirectory: '',
        timeoutSeconds: 600,
        required: true,
        mutatesWorkspace: false,
        environmentAllowlist: [],
        setup: [],
        enabled: true,
      })
      expect(config.id).toBe('unit')
      expect((await listCheckConfigs(pool, context.scope)).map((item) => item.id)).toEqual(['unit'])
      // A working directory outside the workspace is refused.
      await expect(
        saveCheckConfig(pool, context.scope, { ...config, workingDirectory: '../outside' })
      ).rejects.toThrow(/inside the workspace/)

      const runner = { organizationId: context.organizationId, actor: { type: 'runner' as const, runnerId: context.executorId } }
      await inTenantTransaction(pool, runner, async (client) => {
        const task = await loadTaskRow(client, context.scope, context.taskId)
        // A required check with no result for the current revision is a gap.
        expect(await requiredCheckGaps(client, { task, codeRevisionDigest: 'a'.repeat(64) })).toEqual([
          { checkId: 'unit', reason: 'missing' },
        ])
        await expect(
          recordCheckResult(client, {
            task,
            attemptId: null,
            result: {
              checkId: 'unit',
              resolvedCommand: 'npm test',
              passed: true,
              exitCode: 0,
              durationMs: 10,
              timedOut: true,
              truncated: false,
              codeRevisionDigest: 'a'.repeat(64),
              logArtifactId: null,
              setupIssue: null,
            },
          })
        ).rejects.toThrow(/timed out cannot be recorded as passing/)
        await recordCheckResult(client, {
          task,
          attemptId: null,
          result: {
            checkId: 'unit',
            resolvedCommand: 'npm test',
            passed: true,
            exitCode: 0,
            durationMs: 10,
            timedOut: false,
            truncated: false,
            codeRevisionDigest: 'a'.repeat(64),
            logArtifactId: null,
            setupIssue: null,
          },
        })
        expect(await requiredCheckGaps(client, { task, codeRevisionDigest: 'a'.repeat(64) })).toEqual([])
        // The same result does not carry over to a different revision.
        expect(await requiredCheckGaps(client, { task, codeRevisionDigest: 'b'.repeat(64) })).toEqual([
          { checkId: 'unit', reason: 'missing' },
        ])
      })
    } finally {
      await pool.end()
    }
  })

  it('queues an inspection only within the executor capability and the task policy', async () => {
    const pool = runtimePool()
    try {
      const readOnly = await fixture(pool, 'Evidence inspect read-only')
      const queued = await startInspection(pool, readOnly.scope, {
        taskId: readOnly.taskId,
        operation: { kind: 'read_file', path: 'src/index.ts' },
      })
      expect(queued.state).toBe('queued')
      // A path outside the workspace never becomes a job.
      await expect(
        startInspection(pool, readOnly.scope, {
          taskId: readOnly.taskId,
          operation: { kind: 'read_file', path: '../escape.ts' },
        })
      ).rejects.toThrow(/inside the workspace/)
      // Interaction is refused when the executor does not offer it.
      await expect(
        startInspection(pool, readOnly.scope, {
          taskId: readOnly.taskId,
          operation: { kind: 'browser_click', previewId: 'p', ref: 1 },
        })
      ).rejects.toThrow(/does not offer browser interaction/)

      const runner = { organizationId: readOnly.organizationId, actor: { type: 'runner' as const, runnerId: readOnly.executorId } }
      const claimed = await inTenantTransaction(pool, runner, (client) =>
        claimInspection(client, { organizationId: readOnly.organizationId, runnerId: readOnly.executorId })
      )
      expect(claimed?.inspection.id).toBe(queued.id)
      // A second claim finds nothing: the lease already belongs to this run.
      expect(
        await inTenantTransaction(pool, runner, (client) =>
          claimInspection(client, { organizationId: readOnly.organizationId, runnerId: readOnly.executorId })
        )
      ).toBeNull()
      await inTenantTransaction(pool, runner, (client) =>
        completeInspection(client, {
          organizationId: readOnly.organizationId,
          runnerId: readOnly.executorId,
          inspectionId: queued.id,
          body: {
            leaseId: claimed!.leaseId,
            state: 'succeeded',
            result: { text: 'contents' },
            artifactId: null,
            error: null,
            codeRevisionDigest: 'a'.repeat(64),
          },
        })
      )
      const finished = await getInspection(pool, readOnly.scope, { taskId: readOnly.taskId, inspectionId: queued.id })
      expect(finished.state).toBe('succeeded')
      expect(finished.result).toMatchObject({ text: 'contents' })
      expect(finished.codeRevisionDigest).toBe('a'.repeat(64))
      // A wrong lease cannot deliver a result.
      await expect(
        inTenantTransaction(pool, runner, (client) =>
          completeInspection(client, {
            organizationId: readOnly.organizationId,
            runnerId: readOnly.executorId,
            inspectionId: queued.id,
            body: {
              leaseId: randomUUID(),
              state: 'succeeded',
              result: null,
              artifactId: null,
              error: null,
              codeRevisionDigest: null,
            },
          })
        )
      ).rejects.toThrow(/does not belong to this lease/)

      // With the capability advertised but the policy withholding it, interaction is still refused.
      const capable = await fixture(pool, 'Evidence inspect capable', { browserInteract: true })
      await expect(
        startInspection(pool, capable.scope, {
          taskId: capable.taskId,
          operation: { kind: 'browser_click', previewId: 'p', ref: 1 },
        })
      ).rejects.toThrow(/does not authorize preview interaction/)

      const authorized = await fixture(pool, 'Evidence inspect authorized', {
        browserInteract: true,
        previewInteract: true,
      })
      const interactive = await startInspection(pool, authorized.scope, {
        taskId: authorized.taskId,
        operation: { kind: 'browser_click', previewId: 'p', ref: 1 },
      })
      expect(interactive.state).toBe('queued')
    } finally {
      await pool.end()
    }
  })

  it('does not expose evidence to a user without project access', async () => {
    const pool = runtimePool()
    try {
      const context = await fixture(pool, 'Evidence isolation')
      const outsider = 'evid-outsider-' + crypto.randomUUID()
      await teamTransaction(pool, context.scope, async (client) => {
        await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'member')", [
          context.organizationId,
          outsider,
        ])
      })
      await expect(
        listDelegationArtifacts(pool, { ...context.scope, userId: outsider }, context.taskId)
      ).rejects.toThrow()
      await expect(listCheckConfigs(pool, { ...context.scope, userId: outsider })).rejects.toThrow()
      await expect(
        startInspection(pool, { ...context.scope, userId: outsider }, {
          taskId: context.taskId,
          operation: { kind: 'read_file', path: 'src/index.ts' },
        })
      ).rejects.toThrow()
    } finally {
      await pool.end()
    }
  })
})
