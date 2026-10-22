/**
 * MAESTRLY CHAT `generate_image` tool: the SAME imagegen contract for every model, including Codex.
 *
 * Draws on a connected subscription — ChatGPT through an ephemeral Codex thread, or Google AI through an ephemeral
 * Antigravity session (see `generateConversationImage` in ../image-gen.ts) — never a separate Image API or key.
 * The app-owned store writes the artifact; the runner publishes the `generated-image` part via
 * `ctx.emitGeneratedImage`: the model receives only a TEXTUAL REFERENCE (name + revised prompt), never base64
 * — the same invariant keeping parts_json and transcript reseeds small.
 */
import path from 'node:path'
import { z } from 'zod'
import { defineTool, type GeneratedImageEmission } from './util'

const parameters = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('Full description of the image to generate, in English, including style and composition details.'),
  outputPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Relative path inside the conversation worktree where the generated asset should be written, for example public/images/hero.png. Use this when the image is part of the project implementation; omit it only for chat preview.'
    ),
})

/** Output files a running call is writing, so two parallel calls never race on one path. */
const writing = new Set<string>()

interface GenerateImageResult {
  name: string
  revisedPrompt?: string
  outputPath?: string
  overwritten?: boolean
}

export const generateImageTool = defineTool<typeof parameters, GenerateImageResult>({
  name: 'generate_image',
  description:
    'Generates an IMAGE from a text prompt and always shows a persistent preview in this conversation. When ' +
    'the image is part of the project you are implementing, set outputPath to a relative worktree path such ' +
    'as public/images/hero.png; the result returns the exact created path for immediate use in HTML/CSS/JS. ' +
    'Omit outputPath only when the user wants a chat-only preview. You never receive the bytes. Use this for ' +
    'pictures, illustrations, diagram art, mockups, icons or other visuals that must be drawn rather than ' +
    'written. Describe the image fully in the prompt — the generator sees only this text.',
  parameters,
  // Each call generates on an ephemeral thread of its own, so independent images overlap; it still writes files.
  metadata: { parallelSafe: true, readOnly: false },
  execute: async (args, ctx) => {
    // The runner registers this tool only when it can publish the part; without the hook, the image would be orphaned
    // (on disk but invisible), so reject before consuming the user's subscription.
    const emitGeneratedImage = ctx.emitGeneratedImage
    if (!emitGeneratedImage) throw new Error('Image generation is not available in this conversation.')
    let claimed: string | null = null
    try {
      if (args.outputPath) {
        // Claimed before any await, so the check and the claim cannot interleave with another call's. Every variant of
        // the file (the same directory and stem, any extension) may be written, so the stem is what is claimed.
        const target = path.parse(path.resolve(ctx.cwd, args.outputPath))
        const key = `${ctx.conversationId}\0${path.join(target.dir, target.name)}`
        if (writing.has(key))
          throw new Error(
            `Another generate_image call is already writing ${args.outputPath}. Use a different outputPath.`
          )
        writing.add(key)
        claimed = key
        const { resolveGeneratedImageOutputCandidates } = await import('../generated-images')
        const possibleTargets = resolveGeneratedImageOutputCandidates(ctx.cwd, args.outputPath)
        // Approve BEFORE generating. Since the actual format is known only afterward, cover all supported
        // extensions for the same directory/stem — no variant may overwrite without authorization.
        await ctx.ask('edit', possibleTargets, ['*'])
      }
      // Dynamic import keeps the tool registry lightweight (the Codex and Antigravity managers pull their runtimes)
      // and loads this path only when the model requests an image.
      let usageReported = false
      const reportUsage = (usage: NonNullable<GeneratedImageEmission['usage']>): void => {
        // Runtime callback and returned image.usage are two delivery paths for the same
        // auxiliary call. The first non-empty report owns accounting for this tool call.
        if (usageReported) return
        if (
          ![usage.input, usage.output, usage.cachedInput, usage.cacheCreate].some(
            (value) => Number.isFinite(value) && Number(value) > 0
          )
        )
          return
        usageReported = true
        ctx.onGeneratedImageUsage?.(usage)
      }
      const image = ctx.generateImage
        ? await ctx.generateImage(args.prompt, ctx.signal, reportUsage)
        : await (async () => {
            const { generateConversationImage } = await import('../image-gen')
            return generateConversationImage({
              conversationId: ctx.conversationId,
              cwd: ctx.cwd,
              prompt: args.prompt,
              signal: ctx.signal,
              onUsage: reportUsage,
            })
          })()
      if (!usageReported && image.usage) reportUsage(image.usage)
      let materialized: { path: string; existed: boolean } | undefined
      try {
        ctx.signal.throwIfAborted()
        if (args.outputPath) {
          const { materializeGeneratedImage } = await import('../generated-images')
          materialized = await materializeGeneratedImage({
            conversationId: ctx.conversationId,
            artifactId: image.artifactId,
            expectedByteSize: image.byteSize,
            cwd: ctx.cwd,
            outputPath: args.outputPath,
          })
        }
        ctx.signal.throwIfAborted()
        emitGeneratedImage(image)
      } catch (error) {
        // The file exists when the hook runs. Abort or part-persistence failure must not orphan it;
        // delete best-effort and keep the original error as the tool response.
        const { deleteGeneratedImages } = await import('../generated-images')
        await deleteGeneratedImages(ctx.conversationId, [image.artifactId])
        throw error
      }
      return {
        name: image.name,
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
        ...(materialized ? { outputPath: materialized.path, overwritten: materialized.existed } : {}),
      }
    } finally {
      // Only this call's own claim: a call refused for a taken path never releases the other one's.
      if (claimed) writing.delete(claimed)
    }
  },
  toModelText: (_args, result) => {
    const destination = result.outputPath
      ? `Project asset ${result.overwritten ? 'overwritten' : 'created'} at "${result.outputPath}". Use this exact relative path in the project code.`
      : 'No project file was requested; this is a chat-only preview.'
    return [
      `Image generated and shown to the user as "${result.name}".`,
      destination,
      result.revisedPrompt ? `Revised prompt: ${result.revisedPrompt}` : '',
      'Do not describe the bytes and do not call this tool again for the same request.',
    ]
      .filter(Boolean)
      .join('\n')
  },
})
