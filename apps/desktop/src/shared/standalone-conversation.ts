import { z } from 'zod'

/** The main process owns identity, directory, experience and permissions. */
export const createStandaloneConversationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
export type CreateStandaloneConversationArgs = z.infer<typeof createStandaloneConversationSchema>
