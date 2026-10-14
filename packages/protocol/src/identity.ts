import { z } from 'zod'

export const opaqueIdSchema = z.string().min(1).max(191)
export const utcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith('Z'), 'date-time must be normalized to UTC')
