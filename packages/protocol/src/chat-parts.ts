import { z } from 'zod'

const key = z.string().min(1).max(191)
const text = z.string().max(1_000_000)
export const chatPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), id: key, text }).strict(),
  z.object({ type: z.literal('reasoning'), id: key, text }).strict(),
  z
    .object({
      type: z.literal('tool'),
      id: key,
      name: key,
      state: key,
      input: z.string().max(32768).optional(),
      output: z.string().max(65536).optional(),
    })
    .strict(),
])
export const chatQuestionSchema = z.object({
  header: z.string().optional(),
  question: z.string().min(1).max(8000),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .max(20)
    .default([]),
  multiple: z.boolean().optional(),
})
export type ChatPart = z.infer<typeof chatPartSchema>
