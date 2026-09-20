import {
  assertAcyclicStageInputs,
  builtInDelegationPresets,
  defaultDelegationPolicy,
  delegationPresetInputSchema,
  delegationPresetSchema,
  mergeDelegationPolicy,
  stageDefinitionInputSchema,
  type DelegationPreset,
  type DelegationPresetInput,
  type DelegationPresetPatch,
} from '@maestrly/protocol'
import type { DatabaseClient, DatabasePool } from '../../db/pool.js'
import { inTenantTransaction } from '../../db/transaction.js'
import { authorizeProject } from '../access/authorize.js'
import { delegationFail } from './repository.js'

function mapPreset(row: Record<string, unknown>): DelegationPreset {
  return delegationPresetSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    version: Number(row.version),
    policy: row.policy,
    stages: row.stages,
    builtIn: row.built_in,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  })
}

/** Seed the built-in pipelines once per project. Re-seeding never rewrites a preset an operator edited. */
async function seedBuiltIns(client: DatabaseClient, organizationId: string, projectId: string) {
  for (const preset of builtInDelegationPresets())
    await client.query(
      `insert into delegation_presets(organization_id, project_id, name, description, policy, stages, built_in)
       values($1,$2,$3,$4,$5,$6,true)
       on conflict (organization_id, project_id, name) do nothing`,
      [organizationId, projectId, preset.name, preset.description, preset.policy, JSON.stringify(preset.stages)]
    )
}

export async function listDelegationPresets(
  pool: DatabasePool,
  scope: { organizationId: string; projectId: string; userId: string }
): Promise<DelegationPreset[]> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'project:read')
      await seedBuiltIns(client, scope.organizationId, scope.projectId)
      const rows = await client.query(
        'select * from delegation_presets where organization_id=$1 and project_id=$2 order by built_in desc, name',
        [scope.organizationId, scope.projectId]
      )
      return rows.rows.map(mapPreset)
    }
  )
}

export async function loadPreset(
  client: DatabaseClient,
  scope: { organizationId: string; projectId: string },
  presetId: string
): Promise<DelegationPreset> {
  await seedBuiltIns(client, scope.organizationId, scope.projectId)
  const rows = await client.query(
    'select * from delegation_presets where organization_id=$1 and project_id=$2 and id=$3',
    [scope.organizationId, scope.projectId, presetId]
  )
  if (!rows.rows[0]) delegationFail('Preset not found.', 404)
  return mapPreset(rows.rows[0])
}

function validateStages(input: DelegationPresetInput) {
  const stages = input.stages.map((stage) => stageDefinitionInputSchema.parse(stage))
  assertAcyclicStageInputs(stages)
  return stages
}

export async function createDelegationPreset(
  pool: DatabasePool,
  scope: { organizationId: string; projectId: string; userId: string },
  raw: DelegationPresetInput
): Promise<DelegationPreset> {
  const input = delegationPresetInputSchema.parse(raw)
  const stages = validateStages(input)
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'automation:manage')
      const policy = mergeDelegationPolicy(defaultDelegationPolicy(), input.policy)
      const rows = await client.query(
        `insert into delegation_presets(organization_id, project_id, name, description, policy, stages, built_in)
         values($1,$2,$3,$4,$5,$6,false) returning *`,
        [scope.organizationId, scope.projectId, input.name, input.description, policy, JSON.stringify(stages)]
      )
      return mapPreset(rows.rows[0]!)
    }
  )
}

/** Editing a preset only affects future tasks; a running pipeline keeps its own stage revisions. */
export async function patchDelegationPreset(
  pool: DatabasePool,
  scope: { organizationId: string; projectId: string; userId: string; presetId: string },
  patch: DelegationPresetPatch
): Promise<DelegationPreset> {
  return inTenantTransaction(
    pool,
    { organizationId: scope.organizationId, projectId: scope.projectId, actor: { type: 'human', userId: scope.userId } },
    async (client) => {
      await authorizeProject(client, scope.organizationId, scope.projectId, scope.userId, 'automation:manage')
      const current = await client.query(
        'select * from delegation_presets where organization_id=$1 and project_id=$2 and id=$3 for update',
        [scope.organizationId, scope.projectId, scope.presetId]
      )
      const row = current.rows[0]
      if (!row) delegationFail('Preset not found.', 404)
      if (Number(row.version) !== patch.expectedVersion) delegationFail('The preset changed after it was loaded.')
      const existing = mapPreset(row)
      const stages = patch.stages
        ? validateStages({ name: existing.name, description: existing.description, stages: patch.stages })
        : existing.stages
      const policy = patch.policy ? mergeDelegationPolicy(existing.policy, patch.policy) : existing.policy
      const updated = await client.query(
        `update delegation_presets set name=$4, description=$5, policy=$6, stages=$7, version=version+1, updated_at=now()
         where organization_id=$1 and project_id=$2 and id=$3 returning *`,
        [
          scope.organizationId,
          scope.projectId,
          scope.presetId,
          patch.name ?? existing.name,
          patch.description ?? existing.description,
          policy,
          JSON.stringify(stages),
        ]
      )
      return mapPreset(updated.rows[0]!)
    }
  )
}
