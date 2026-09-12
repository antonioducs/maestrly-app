import { z } from 'zod'

export const errorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'PROTOCOL_INCOMPATIBLE',
  'LEASE_EXPIRED',
  'RUNNER_REVOKED',
  'CAPABILITY_MISMATCH',
  'RATE_LIMITED',
  'INTERNAL',
])

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1).max(1_000),
  requestId: z.string().min(1).max(191),
  details: z.record(z.string(), z.unknown()).optional(),
})

export type ErrorCode = z.infer<typeof errorCodeSchema>
export type ApiError = z.infer<typeof apiErrorSchema>
