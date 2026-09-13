import { z } from 'zod'

export const id = z.string().min(1).max(128)
export const revision = z.number().int().nonnegative()
export const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
})
