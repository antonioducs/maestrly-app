import { z } from 'zod'
import { runnerAutomationCapabilitiesSchema } from './automation.js'

export const personalExecutionRequestSchema = z
  .object({
    deviceId: z.string().uuid(),
    expectedPolicyId: z.string().uuid().nullable(),
    expectedOverrideVersion: z.number().int().nonnegative(),
  })
  .strict()
export const personalDeviceSnapshotSchema = z
  .object({
    deviceId: z.string().uuid(),
    ownerUserId: z.string().min(1).max(191),
    name: z.string().min(1).max(160),
  })
  .strict()
export const personalDeviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  enabled: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  capabilities: runnerAutomationCapabilitiesSchema.nullable(),
  repositories: z.array(
    z.object({
      bindingId: z.string(),
      available: z.boolean(),
      branches: z.array(z.string()),
      error: z.string().optional(),
    })
  ),
})
export type PersonalDevice = z.infer<typeof personalDeviceSchema>
export type PersonalExecutionRequest = z.infer<typeof personalExecutionRequestSchema>
