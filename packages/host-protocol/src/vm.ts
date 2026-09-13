import { z } from 'zod'
import { id, revision } from './common.js'
export const vmSchema = z.strictObject({
  id,
  name: z.string(),
  imageId: id,
  runtimeId: id,
  cpus: z.number().int().positive(),
  memoryMiB: z.number().int().positive(),
  diskGiB: z.number().int().positive(),
  revision,
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'unknown', 'removed']),
  desiredState: z.enum(['running', 'stopped']).default('stopped'),
  health: z.enum(['unknown', 'provisioning', 'ready', 'unresponsive']).default('unknown'),
  startupPolicy: z.enum(['manual', 'always']).default('manual'),
  diskRetained: z.boolean().default(true),
  bootId: z.string().uuid().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  identity: z.string().uuid(),
})
export const verifyResultSchema = z.strictObject({
  ready: z.boolean(),
  markerMatches: z.boolean(),
  networkIsolated: z.boolean(),
  bootId: z.string().uuid(),
})
export type VerifyResult = z.infer<typeof verifyResultSchema>
export type Vm = z.infer<typeof vmSchema>
