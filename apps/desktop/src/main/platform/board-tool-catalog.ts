import { z } from 'zod'
import {
  linkedBoardReadTools,
  linkedBoardToolDescriptions,
  linkedBoardToolSchemas,
  linkedBoardToolJsonSchema,
  type LinkedBoardToolName,
} from '@maestrly/protocol'

export const linkedBoardCatalog = Object.entries(linkedBoardToolSchemas).map(([key]) => {
  const name = key as LinkedBoardToolName
  const schema = z.fromJSONSchema(linkedBoardToolJsonSchema(name)) as z.ZodObject<z.ZodRawShape>
  const readOnly = linkedBoardReadTools.has(name)
  return {
    name,
    readOnly,
    description:
      linkedBoardToolDescriptions[name] +
      (readOnly ? '' : ' Supply a stable idempotencyKey for each change and reuse it when retrying that same change.'),
    schema: readOnly
      ? schema
      : schema.extend({
          idempotencyKey: z
            .string()
            .min(8)
            .max(128)
            .regex(/^[A-Za-z0-9_-]+$/),
        }),
  }
})
