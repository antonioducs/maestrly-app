import type { ChatBehavior } from '../../shared/conversation-experience'
import { capabilityBehaviorFor } from '../../shared/chat-mode'
import type { ToolSet } from 'ai'
import {
  chatToolOutputToAiSdkOutput,
  describeToolOutputImages,
  modelOutputToChatToolOutput,
} from './tool-output'
import { toolOutputImages, type ChatToolImage } from '../../shared/chat'

/**
 * Capability decision shared by BYOK and the subscription runners.
 *
 * The default keeps the existing optimistic behavior for parent/BYOK requests whose catalog is incomplete. Child
 * runtimes should pass `unknownVision: 'unsupported'` and the interpreter readiness state so an unverified model
 * gets the interpreter-first policy only when that fallback is locally known to be available. `false` and
 * `undefined` both preserve raw images for unknown vision; an explicit `modelVision: false` remains text-only.
 */
export function supportsChatToolImages(args: {
  modelVision?: boolean
  runtimeImageUnsupported?: boolean
  unknownVision?: 'supported' | 'unsupported'
  /** True only after provider/auth readiness is established without a runtime refresh. */
  imageInterpreterConfigured?: boolean
}): boolean {
  if (args.runtimeImageUnsupported === true) return false
  if (args.modelVision !== undefined) return args.modelVision
  return args.unknownVision !== 'unsupported' || args.imageInterpreterConfigured !== true
}

/** A worker may receive image results in any mode, but image generation requires Agent capabilities. */
export function canExposeGeneratedImageTool(args: { mode: ChatBehavior; enabled: boolean }): boolean {
  return capabilityBehaviorFor(args.mode) === 'agent' && args.enabled
}

/** Wraps a host ToolSet at the model boundary so a child model can have different vision capability than its parent. */
export function adaptToolSetForModel(args: {
  tools: ToolSet
  supportsImages: boolean
  describeImage?: (image: ChatToolImage) => Promise<{ text: string; model?: string } | null>
}): ToolSet {
  if (args.supportsImages) return args.tools
  const adapted: ToolSet = { ...args.tools }
  for (const [name, rawTool] of Object.entries(args.tools)) {
    const execute = (rawTool as { execute?: unknown }).execute
    if (typeof execute !== 'function') continue
    adapted[name] = {
      ...(rawTool as object),
      execute: async (input: unknown, options: unknown) => {
        const result = await (execute as (input: unknown, options: unknown) => unknown)(input, options)
        const normalized = modelOutputToChatToolOutput(result)
        const images = toolOutputImages(normalized)
        if (typeof normalized === 'string' || images.length === 0) return result
        // Keep the canonical result (including opaque image handles) for the host fold. The model-facing
        // projection below is the only place where a non-vision runtime removes image content.
        return describeToolOutputImages(normalized, args.describeImage)
      },
      toModelOutput: async ({ output }: { output: unknown }) => {
        const normalized = modelOutputToChatToolOutput(output)
        return chatToolOutputToAiSdkOutput(normalized, { dropImages: true })
      },
    } as unknown as (typeof adapted)[string]
  }
  return adapted
}
