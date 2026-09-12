import { z } from 'zod'
import { defineTool } from './util'

const searchParameters = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
})

const readParameters = z.object({
  around_seq: z.number().int().min(0),
  limit: z.number().int().min(1).max(20).optional(),
})

export const searchExecutionContextTool = defineTool({
  name: 'search_execution_context',
  description: 'Searches bounded, user-visible requirements in the executor conversation fixed by the host.',
  parameters: searchParameters,
  execute: async (input, ctx) => {
    if (!ctx.reviewer) throw new Error('search_execution_context is reviewer-only')
    const result = await ctx.reviewer.searchExecutionContext(input)
    ctx.reviewer.recordEvidence('context-search')
    return result
  },
  toModelText: (_input, result) => JSON.stringify(result),
})

export const readExecutionContextTool = defineTool({
  name: 'read_execution_context',
  description: 'Reads a bounded page of user-visible executor conversation context around a host-scoped sequence.',
  parameters: readParameters,
  execute: async (input, ctx) => {
    if (!ctx.reviewer) throw new Error('read_execution_context is reviewer-only')
    const result = await ctx.reviewer.readExecutionContext(input)
    ctx.reviewer.recordEvidence('context-read')
    return result
  },
  toModelText: (_input, result) => JSON.stringify(result),
})
