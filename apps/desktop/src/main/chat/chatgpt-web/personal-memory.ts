import { z } from 'zod'
import { scheduleMemoryExtraction, type ExtractionDeps } from '../../memory/extraction/scheduler'
import type { ChatGptWebCapabilityScope, ChatMode } from '../../../shared/chat'
import { tFor } from '../../../shared/i18n'
import { registerMemoryTools } from '../../mcp/tools/memory'
import type { McpToolContext } from '../../mcp/tools/context'
import { onMemorySpaceEnabledChanged } from '../../memory/access'
import { PERSONAL_MEMORY_SPACE_ID } from '../../../shared/memory'
import { memorySpaceForConversation } from '../../memory/spaces'

export const PERSONAL_MEMORY_OPERATIONS = ['search', 'list', 'read', 'upsert', 'archive', 'restore', 'forget'] as const
const requestSchema = z
  .object({
    operation: z.enum(PERSONAL_MEMORY_OPERATIONS),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict()

interface NativeTool {
  inputSchema: z.ZodRawShape
  run: (input: Record<string, unknown>) => Promise<unknown>
}

export interface PersonalMemoryAdapterOptions {
  conversationId: string
  /** Host checks session identity/fingerprint and resolves current access on every call. */
  access: () => ChatGptWebCapabilityScope
  mode: () => ChatMode
  authorizeWrite: (toolName: string, signal?: AbortSignal) => Promise<void>
}

/** Reuse native operations, schemas and storage; neither the browser nor the model chooses a space. */
export function createPersonalMemoryAdapter(options: PersonalMemoryAdapterOptions) {
  function gate(write: boolean, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    const access = options.access()
    if (access !== 'read' && access !== 'write') throw new Error('personal-memory-disabled')
    if (memorySpaceForConversation(options.conversationId)?.kind !== 'personal') {
      throw new Error('personal-memory-unavailable')
    }
    if (write && access !== 'write') throw new Error('personal-memory-read-only')
    const mode = options.mode()
    if (write && mode !== 'agent' && mode !== 'design') {
      throw new Error('personal-memory-mode-denied')
    }
  }
  return {
    /** Completion is only a trigger; the scheduler reads real persisted user rows, never browser history. */
    scheduleExtraction(deps: Partial<ExtractionDeps> = {}): void {
      const authorized = () => {
        try {
          gate(true)
          return true
        } catch {
          return false
        }
      }
      if (!authorized()) return
      scheduleMemoryExtraction(options.conversationId, undefined, { ...deps, authorized })
    },
    async call(input: Record<string, unknown>, requestSignal?: AbortSignal): Promise<unknown> {
      const revoked = new AbortController()
      const signal = AbortSignal.any([revoked.signal, ...(requestSignal ? [requestSignal] : [])])
      const unsubscribe = onMemorySpaceEnabledChanged(({ workspaceId, enabled }) => {
        if (workspaceId === PERSONAL_MEMORY_SPACE_ID && !enabled) {
          revoked.abort(new Error('personal-memory-disabled'))
        }
      })
      try {
        gate(false, signal)
        const request = requestSchema.parse(input)
        const write = !['search', 'list', 'read'].includes(request.operation)
        gate(write, signal)
        const tools = new Map<string, NativeTool>()
        registerMemoryTools({
          convId: options.conversationId,
          locale: 'en',
          t: tFor('en', 'mcp'),
          server: {
            registerTool: (name: string, schema: { inputSchema: z.ZodRawShape }, run: NativeTool['run']) =>
              tools.set(name, { inputSchema: schema.inputSchema, run }),
          },
        } as unknown as McpToolContext)
        const name = `memory_${request.operation}`
        const tool = tools.get(name)
        if (!tool) throw new Error('personal-memory-unavailable')
        // Strict validation rejects model-provided workspace/space/conversation IDs rather than silently ignoring them.
        const args = z.object(tool.inputSchema).strict().parse(request.arguments)
        if (request.operation === 'read' && !args.id) throw new Error('memory-id-required')
        if (write) await options.authorizeWrite(name, signal)
        // Approval and search may yield; revocation, mode changes and ended sessions must fail closed.
        gate(write, signal)
        const result = await tool.run(args)
        gate(write, signal)
        return result
      } finally {
        unsubscribe()
      }
    },
  }
}
