import { personalDeviceSnapshotSchema } from './personal-devices.js'
import {columnAutomationSchema,runnerAutomationCapabilitiesSchema} from './automation.js'
import { z } from 'zod'
import { opaqueIdSchema, utcDateTimeSchema } from './identity.js'

export const capabilitySchema = z.object({
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(80).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
})

export const deliveryPolicySchema = z.object({
  mode: z.enum(['patch', 'commit', 'push']).default('patch'),
  requireHumanApproval: z.boolean().default(true),
  targetBranch: z.string().min(1).max(250).optional(),
})

export const executionPolicySchema = z.object({
  policyKey:opaqueIdSchema.optional(),
  automationConfig:columnAutomationSchema.optional(),
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  version: z.number().int().positive(),
  name: z.string().min(1).max(160),
  taskType: z.string().min(1).max(120),
  executionProfileId: opaqueIdSchema,
  requiredCapabilities: z.array(capabilitySchema).max(100),
  repositoryBindingId: opaqueIdSchema.nullable(),
  repositoryBranch: z.string().min(1).max(250).optional(),
  provider: z.enum(['codex', 'claude-agent', 'maestrly']),
  model: z.string().min(1).max(160),
  effort: z.string().max(80).optional(),
  approvalRequired: z.boolean(),
  maxDurationSeconds: z.number().int().positive().max(86_400),
  maxLogBytes: z.number().int().positive(),
  delivery: deliveryPolicySchema,
  continuation: z.object({
    priorRunId: opaqueIdSchema,
    question: z.string().max(100_000),
    response: z.string().max(100_000),
  }).optional(),
  enabled: z.boolean(),
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const executionSnapshotSchema = z.object({
  personalDevice:personalDeviceSnapshotSchema.optional(),
  sourceCardVersion:z.number().int().positive().optional(),
  automationVersion:z.literal(1).optional(),
  automation:columnAutomationSchema.optional(),
  renderedPrompt:z.string().max(200_000).optional(),
  fastMode:z.boolean().optional(),
  fastServiceTier:z.string().max(80).optional(),
  targetRunnerId:z.string().uuid().nullable().optional(),
  maxDurationSeconds:z.number().int().positive().max(86400).optional(),
  maxLogBytes:z.number().int().positive().max(10485760).optional(),
  continuation:z.object({priorRunId:opaqueIdSchema,question:z.string(),response:z.string()}).optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(100_000),
  acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100),
  taskType: z.string().min(1).max(120),
  provider: z.enum(['codex', 'claude-agent', 'maestrly']),
  model: z.string().min(1).max(160),
  effort: z.string().max(80).optional(),
  repositoryBindingId: opaqueIdSchema.nullable(),
  repositoryBranch: z.string().min(1).max(250).optional(),
  delivery: deliveryPolicySchema,
})

export const executionEnvelopeSchema = z.object({
  protocolVersion: z.string().min(1),
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  cardId: opaqueIdSchema,
  jobId: opaqueIdSchema,
  runId: opaqueIdSchema,
  attempt: z.number().int().positive(),
  leaseId: opaqueIdSchema,
  leaseExpiresAt: utcDateTimeSchema,
  sourceEventId: opaqueIdSchema,
  cardVersion: z.number().int().positive(),
  policyVersion: z.number().int().positive(),
  executionProfileId: opaqueIdSchema,
  snapshot: executionSnapshotSchema,
})

export const jobStateSchema = z.enum([
  'waiting_approval',
  'queued',
  'active',
  'waiting_input',
  'needs_attention',
  'completed',
  'cancelled',
])
export const runStateSchema = z.enum([
  'claimed',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'needs_input',
])

export const jobSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  cardId: opaqueIdSchema,
  sourceEventId: opaqueIdSchema,
  policyId: opaqueIdSchema,
  policyVersion: z.number().int().positive(),
  state: jobStateSchema,
  createdAt: utcDateTimeSchema,
  updatedAt: utcDateTimeSchema,
})

export const runSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  jobId: opaqueIdSchema,
  runnerId: opaqueIdSchema,
  attempt: z.number().int().positive(),
  state: runStateSchema,
  leaseId: opaqueIdSchema,
  leaseExpiresAt: utcDateTimeSchema,
  startedAt: utcDateTimeSchema.nullable(),
  finishedAt: utcDateTimeSchema.nullable(),
})

export const runnerSchema = z.object({
  automationCapabilities:runnerAutomationCapabilitiesSchema.nullable().optional(),
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string().min(1).max(160),
  status: z.enum(['online', 'offline', 'revoked']),
  protocolVersion: z.string().min(1),
  capabilities: z.array(capabilitySchema).max(100),
  maxConcurrency: z.number().int().positive().max(128),
  lastSeenAt: utcDateTimeSchema.nullable(),
})

export const approvalSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  jobId: opaqueIdSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'revoked']),
  requestedByUserId: opaqueIdSchema,
  decidedByUserId: opaqueIdSchema.nullable(),
  createdAt: utcDateTimeSchema,
  decidedAt: utcDateTimeSchema.nullable(),
})

export const artifactSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  runId: opaqueIdSchema,
  kind: z.enum(['summary', 'patch', 'commit', 'log', 'verification', 'attachment', 'orphaned_evidence']),
  name: z.string().min(1).max(500),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().nonnegative(),
  digest: z.string().min(1).max(200),
  createdAt: utcDateTimeSchema,
})

export type Capability = z.infer<typeof capabilitySchema>
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>
export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>
export type Job = z.infer<typeof jobSchema>
export type Run = z.infer<typeof runSchema>
export type Runner = z.infer<typeof runnerSchema>
export type Approval = z.infer<typeof approvalSchema>
export type Artifact = z.infer<typeof artifactSchema>
export type JobState = z.infer<typeof jobStateSchema>
export type RunState = z.infer<typeof runStateSchema>
