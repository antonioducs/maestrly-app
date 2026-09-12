import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonSchema } from 'ai'
import { toolOutputImages, type ToolOutput } from '../../src/shared/chat'
import { TOOL_IMAGE_CACHE_HARD_TRIM_BYTES, TOOL_IMAGE_CACHE_TTL_MS } from '../../src/shared/memory-policy'

const reclaimH = vi.hoisted(() => {
  const registered: Array<Record<string, unknown>> = []
  return {
    registered,
    registerReclaimable: vi.fn((resource: unknown) => {
      registered.push(resource as Record<string, unknown>)
    }),
    unregisterReclaimable: vi.fn(),
  }
})

vi.mock('../../src/main/performance/memory-reclaimer', () => ({
  registerReclaimable: reclaimH.registerReclaimable,
  unregisterReclaimable: reclaimH.unregisterReclaimable,
}))
import {
  chatToolOutputToAiSdkOutput,
  clearEphemeralToolImages,
  codexContentItemsToChatToolOutput,
  copilotResultToChatToolOutput,
  getEphemeralToolImage,
  getEphemeralToolImageCacheSnapshot,
  hasEphemeralToolImage,
  MAX_EPHEMERAL_IMAGE_BYTES,
  MAX_TOOL_IMAGES_PER_RESULT,
  mcpResultToChatToolOutput,
  mergeToolOutputImageDescriptions,
  modelOutputToChatToolOutput,
  resolveEphemeralToolImage,
  sanitizeToolOutputForPersistence,
  stripToolOutputMetadata,
  toolOutputForPersistence,
  toolOutputToCodexContentItems,
  toolOutputToCopilotResult,
  toolOutputToMcpCallResult,
} from '../../src/main/chat/tool-output'
import { adaptToolSetForModel, supportsChatToolImages } from '../../src/main/chat/tool-capabilities'

const IMAGE_DATA = 'aGVsbG8='
const IMAGE_URL = `data:image/png;base64,${IMAGE_DATA}`

afterEach(() => clearEphemeralToolImages())

describe('host-owned multimodal tool output', () => {
  it('keeps MCP images as opaque refs while projecting files to the AI SDK', () => {
    const output = mcpResultToChatToolOutput({
      content: [
        { type: 'text', text: 'screenshot returned' },
        { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
      ],
      structuredContent: { image_data: IMAGE_URL, status: 'ok' },
    })

    expect(output.text).toContain('screenshot returned')
    expect(output.text).toContain('Structured content:')
    expect(toolOutputImages(output)).toHaveLength(1)
    expect(JSON.stringify(output)).not.toContain(IMAGE_DATA)
    expect(JSON.stringify(output)).not.toContain(IMAGE_URL)

    const projected = chatToolOutputToAiSdkOutput(output)
    expect(projected).toMatchObject({ type: 'content' })
    const file = (projected as { type: 'content'; value: unknown[] }).value.find(
      (part) => (part as { type?: string }).type === 'file'
    ) as { data: { type: string; data: string }; mediaType: string }
    expect(file).toMatchObject({ mediaType: 'image/png', data: { type: 'data', data: IMAGE_DATA } })
  })

  it('strips canonical metadata only from the provider-facing clone', () => {
    const canonical = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const projected = chatToolOutputToAiSdkOutput(canonical, { dropImages: true })
    const providerOutput = stripToolOutputMetadata(projected)

    expect(toolOutputImages(modelOutputToChatToolOutput(projected))).toHaveLength(1)
    expect(toolOutputImages(modelOutputToChatToolOutput(providerOutput))).toHaveLength(0)
    expect(JSON.stringify(providerOutput)).not.toContain(IMAGE_DATA)
    expect(toolOutputImages(canonical)).toHaveLength(1)
  })

  it('round-trips images through Codex inputImage without making bytes persistable', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const items = toolOutputToCodexContentItems(output)
    expect(items).toEqual([
      { type: 'inputText', text: '(image output)' },
      { type: 'inputImage', imageUrl: IMAGE_URL },
    ])

    const roundTrip = codexContentItemsToChatToolOutput(items)
    expect(toolOutputImages(roundTrip)).toHaveLength(1)
    expect(toolOutputImages(roundTrip)[0]?.id).toBe(toolOutputImages(output)[0]?.id)
    expect(JSON.stringify(roundTrip)).not.toContain(IMAGE_DATA)
  })

  it('projects images to Copilot binaryResultsForLlm and back to refs', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const result = toolOutputToCopilotResult(output)
    expect(result).toMatchObject({
      textResultForLlm: '(image output)',
      binaryResultsForLlm: [{ data: IMAGE_DATA, mimeType: 'image/png', type: 'image' }],
    })

    const roundTrip = copilotResultToChatToolOutput(result)
    expect(toolOutputImages(roundTrip)).toHaveLength(1)
    expect(toolOutputImages(roundTrip)[0]?.id).toBe(toolOutputImages(output)[0]?.id)
    expect(JSON.stringify(roundTrip)).not.toContain(IMAGE_DATA)
  })

  it('deduplicates cache bytes while keeping metadata on each reference', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const echoed = copilotResultToChatToolOutput({
      textResultForLlm: 'Screenshot echoed by Copilot.',
      binaryResultsForLlm: [{ data: IMAGE_DATA, mimeType: 'image/png', type: 'image', description: 'A screenshot' }],
    })

    expect(toolOutputImages(echoed)[0]?.id).toBe(toolOutputImages(output)[0]?.id)
    expect(toolOutputImages(echoed)[0]).toMatchObject({ description: 'A screenshot' })
    expect(toolOutputImages(output)[0]).not.toHaveProperty('description')
  })

  it('converts native AI SDK file content back to the safe state contract', () => {
    const output = modelOutputToChatToolOutput({
      type: 'content',
      value: [
        { type: 'text', text: 'native result' },
        { type: 'file', data: { type: 'data', data: IMAGE_DATA }, mediaType: 'image/png' },
      ],
    })
    expect(output).toMatchObject({ text: 'native result', images: [{ mediaType: 'image/png' }] })
    expect(JSON.stringify(output)).not.toContain(IMAGE_DATA)
  })

  it('keeps legacy bridge wrappers with textual content textual', () => {
    expect(modelOutputToChatToolOutput({ content: 'wrapped result' })).toBe('wrapped result')
    expect(modelOutputToChatToolOutput({ output: 'wrapped output' })).toBe('wrapped output')
  })

  it('accepts the Anthropic image-source shape emitted by an MCP bridge', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', source: { type: 'base64', data: IMAGE_DATA, media_type: 'image/png' } }],
    })
    expect(toolOutputImages(output)).toHaveLength(1)
    expect(toolOutputImages(output)[0]).toMatchObject({ mediaType: 'image/png' })
    expect(JSON.stringify(output)).not.toContain(IMAGE_DATA)
  })

  it('bounds MCP image retention and records omitted image blocks in text', () => {
    const output = mcpResultToChatToolOutput({
      content: Array.from({ length: MAX_TOOL_IMAGES_PER_RESULT + 2 }, () => ({
        type: 'image',
        data: IMAGE_DATA,
        mimeType: 'image/png',
      })),
    })

    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_IMAGES_PER_RESULT)
    expect(output.text).toContain(`[2 tool images omitted`)
  })

  it('rejects an oversized tool image before placing it in the ephemeral cache', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: new Uint8Array(MAX_EPHEMERAL_IMAGE_BYTES + 1), mimeType: 'image/png' }],
    })

    expect(toolOutputImages(output)).toHaveLength(0)
    expect(output.text).toContain('[1 tool image omitted')
  })

  it('removes binary-looking text and structured data at the SQL boundary', () => {
    const safe = sanitizeToolOutputForPersistence({
      text: `prefix ${IMAGE_URL} ${'A'.repeat(300)} suffix`,
      images: [{ id: 'tool-image:test', mediaType: 'image/png' }],
      structuredContent: { blob: IMAGE_DATA, ok: true },
    })
    expect(JSON.stringify(safe)).not.toContain(IMAGE_DATA)
    expect(JSON.stringify(safe)).not.toContain(IMAGE_URL)
    expect(safe).toMatchObject({ images: [{ id: 'tool-image:test', mediaType: 'image/png' }] })
  })

  it('does not persist arbitrary image ids as if they were host-owned handles', () => {
    const safe = sanitizeToolOutputForPersistence({
      text: 'image',
      images: [{ id: IMAGE_URL, mediaType: 'image/png' }],
    })
    expect(safe).toMatchObject({ images: [{ id: 'tool-image:unavailable' }] })
    expect(JSON.stringify(safe)).not.toContain(IMAGE_DATA)
  })

  it('sanitizes untyped ledger values too, including raw strings and nested binary-looking data', async () => {
    const raw = 'B'.repeat(300)
    expect(toolOutputForPersistence(raw)).toBe('[binary content omitted]')
    expect(toolOutputForPersistence({ payload: raw, note: 'kept' })).toMatchObject({
      payload: '[binary content omitted]',
      note: 'kept',
    })
  })

  it('returns MCP image blocks only as an in-memory provider projection', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const result = toolOutputToMcpCallResult(output)
    expect(result).toEqual({
      content: [
        { type: 'text', text: '(image output)' },
        { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
      ],
    })
  })

  it('adapts a child toolset when the child model lacks vision', async () => {
    expect(supportsChatToolImages({ modelVision: undefined })).toBe(true)
    expect(
      supportsChatToolImages({
        modelVision: undefined,
        unknownVision: 'unsupported',
        imageInterpreterConfigured: false,
      })
    ).toBe(true)
    expect(
      supportsChatToolImages({ modelVision: undefined, unknownVision: 'unsupported', imageInterpreterConfigured: true })
    ).toBe(false)
    expect(supportsChatToolImages({ modelVision: true, unknownVision: 'unsupported' })).toBe(true)
    expect(supportsChatToolImages({ modelVision: false })).toBe(false)
    expect(supportsChatToolImages({ modelVision: false, imageInterpreterConfigured: true })).toBe(false)
    expect(supportsChatToolImages({ modelVision: true, runtimeImageUnsupported: true })).toBe(false)
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const makeTool = () => ({
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => chatToolOutputToAiSdkOutput(output),
    })
    const optimistic = adaptToolSetForModel({
      tools: { screenshot: makeTool() },
      supportsImages: supportsChatToolImages({
        modelVision: undefined,
        unknownVision: 'unsupported',
        imageInterpreterConfigured: false,
      }),
      describeImage: async () => {
        throw new Error('unknown vision without an interpreter must preserve raw image output')
      },
    })
    const optimisticResult = await (
      optimistic.screenshot as { execute: (input: unknown, options: unknown) => Promise<unknown> }
    ).execute({}, {})
    expect(JSON.stringify(optimisticResult)).toContain(IMAGE_DATA)

    const safeUnknown = adaptToolSetForModel({
      tools: { screenshot: makeTool() },
      supportsImages: supportsChatToolImages({
        modelVision: undefined,
        unknownVision: 'unsupported',
        imageInterpreterConfigured: true,
      }),
      describeImage: async () => ({ text: 'unknown model screenshot description', model: 'vision-test' }),
    })
    const safeUnknownResult = await (
      safeUnknown.screenshot as { execute: (input: unknown, options: unknown) => Promise<unknown> }
    ).execute({}, {})
    expect(safeUnknownResult).toMatchObject({
      images: [{ description: 'unknown model screenshot description', descriptionModel: 'vision-test' }],
    })
    expect(JSON.stringify(safeUnknownResult)).not.toContain(IMAGE_DATA)

    const adapted = adaptToolSetForModel({
      tools: {
        screenshot: {
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: async () => chatToolOutputToAiSdkOutput(output),
        },
      },
      supportsImages: false,
      describeImage: async () => ({ text: 'a screenshot described by the interpreter', model: 'vision-test' }),
    })
    const result = await (
      adapted.screenshot as { execute: (input: unknown, options: unknown) => Promise<unknown> }
    ).execute({}, {})
    expect(result).toMatchObject({ images: [{ description: 'a screenshot described by the interpreter' }] })
    const projected = await (
      adapted.screenshot as unknown as {
        toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown>
      }
    ).toModelOutput({ toolCallId: 'screenshot-1', input: {}, output: result })
    expect(JSON.stringify(projected)).toContain('a screenshot described by the interpreter')
    expect(JSON.stringify(projected)).not.toContain(IMAGE_DATA)
  })

  it('bounds interpreter calls for one tool result and marks omitted images', async () => {
    const images = Array.from(
      { length: MAX_TOOL_IMAGES_PER_RESULT + 2 },
      () =>
        toolOutputImages(
          mcpResultToChatToolOutput({ content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }] })
        )[0]!
    )
    const output = { text: 'many screenshots', images }
    let active = 0
    let maxConcurrency = 0
    const describeImage = vi.fn(async () => {
      active++
      maxConcurrency = Math.max(maxConcurrency, active)
      await Promise.resolve()
      active--
      return { text: 'described', model: 'vision-test' }
    })
    const adapted = adaptToolSetForModel({
      tools: {
        screenshots: {
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: async () => chatToolOutputToAiSdkOutput(output),
        },
      },
      supportsImages: false,
      describeImage,
    })

    const result = await (
      adapted.screenshots as { execute: (input: unknown, options: unknown) => Promise<unknown> }
    ).execute({}, {})

    expect(describeImage).toHaveBeenCalledTimes(MAX_TOOL_IMAGES_PER_RESULT)
    expect(maxConcurrency).toBe(1)
    const projected = await (
      adapted.screenshots as unknown as {
        toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown>
      }
    ).toModelOutput({ toolCallId: 'screenshots-1', input: {}, output: result })
    expect(JSON.stringify(projected)).toContain(`[2 tool images omitted`)
  })

  it('propagates an interpreter abort through adapted execute while null preserves canonical output', async () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const makeTool = () => ({
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => chatToolOutputToAiSdkOutput(output),
    })
    const abortController = new AbortController()
    const abortReason = new Error('Stop')
    const describeImage = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          abortController.signal.addEventListener('abort', () => reject(abortController.signal.reason), { once: true })
        })
    )
    const aborted = adaptToolSetForModel({
      tools: { screenshot: makeTool() },
      supportsImages: false,
      describeImage,
    })

    const pending = (aborted.screenshot as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(
      {},
      { abortSignal: abortController.signal }
    )
    await vi.waitFor(() => expect(describeImage).toHaveBeenCalledOnce())
    abortController.abort(abortReason)
    await expect(pending).rejects.toBe(abortReason)

    const bestEffort = adaptToolSetForModel({
      tools: { screenshot: makeTool() },
      supportsImages: false,
      describeImage: async () => null,
    })
    const preserved = await (
      bestEffort.screenshot as { execute: (input: unknown, options: unknown) => Promise<unknown> }
    ).execute({}, {})
    expect(preserved).toEqual(output)
  })
})

describe('monotonic tool image description enrichment', () => {
  const image = (id: string) => ({ id, mediaType: 'image/png', byteSize: 10, name: 'shot.png' })
  const enriched = (): ToolOutput => ({
    text: 'Screenshot captured.',
    images: [
      {
        ...image('tool-image:same'),
        description: 'Terminal screenshot: ENOENT error on line 3.',
        descriptionModel: 'vision-model',
      },
    ],
  })

  it('copies only missing descriptions and preserves current output metadata', () => {
    const current: ToolOutput = {
      text: 'Screenshot AFTER retry: pipeline verde.',
      structuredContent: { status: 'ok', attempts: 2 },
      isError: true,
      images: [image('tool-image:same'), image('tool-image:second')],
    }
    const merged = mergeToolOutputImageDescriptions(current, enriched())
    expect(merged).not.toBe(current)
    expect(merged).toMatchObject({
      text: 'Screenshot AFTER retry: pipeline verde.',
      structuredContent: { status: 'ok', attempts: 2 },
      isError: true,
    })
    const images = toolOutputImages(merged)
    expect(images).toHaveLength(2)
    // Preserve current order and metadata; add only descriptions and their models.
    expect(images[0]).toEqual({
      id: 'tool-image:same',
      mediaType: 'image/png',
      byteSize: 10,
      name: 'shot.png',
      description: 'Terminal screenshot: ENOENT error on line 3.',
      descriptionModel: 'vision-model',
    })
    expect(images[1]).toEqual(image('tool-image:second'))
  })

  it('keeps current descriptions authoritative over snapshots', () => {
    const current: ToolOutput = {
      text: 'newer',
      images: [
        { ...image('tool-image:same'), description: 'description from a newer cycle', descriptionModel: 'other-model' },
      ],
    }
    expect(mergeToolOutputImageDescriptions(current, enriched())).toBe(current)
  })

  it('returns the same reference for missing IDs or images', () => {
    const differentId: ToolOutput = { text: 'x', images: [image('tool-image:other')] }
    expect(mergeToolOutputImageDescriptions(differentId, enriched())).toBe(differentId)
    expect(mergeToolOutputImageDescriptions('plain text', enriched())).toBe('plain text')
    const plain: ToolOutput = { text: 'x' }
    expect(mergeToolOutputImageDescriptions(plain, enriched())).toBe(plain)
    expect(mergeToolOutputImageDescriptions(undefined, enriched())).toBeUndefined()
    expect(mergeToolOutputImageDescriptions(differentId, 'plain text')).toBe(differentId)
  })
})

describe('raw tool-image cache reads and reclamation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reclaimH.registered.length = 0
    reclaimH.unregisterReclaimable.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('projects base64 only at the provider boundary', () => {
    const output = mcpResultToChatToolOutput({
      content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
    })
    const image = toolOutputImages(output)[0]!

    const raw = getEphemeralToolImage(image)
    expect(raw).not.toBeNull()
    expect(raw).not.toHaveProperty('data')
    expect(raw!.bytes).toEqual(new Uint8Array(Buffer.from(IMAGE_DATA, 'base64')))
    expect(raw!.byteSize).toBe(5)
    expect(hasEphemeralToolImage(image)).toBe(true)
    expect(hasEphemeralToolImage({ id: 'tool-image:nonexistent' })).toBe(false)

    // Provider adapters must explicitly project base64.
    const projected = resolveEphemeralToolImage(image)
    expect(projected?.data).toBe(IMAGE_DATA)
  })

  it('registers reclaimable cache resources only while entries exist', () => {
    expect(reclaimH.registered).toHaveLength(0)
    mcpResultToChatToolOutput({ content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }] })
    expect(reclaimH.registered).toHaveLength(1)
    const resource = reclaimH.registered[0]!
    expect(resource).toMatchObject({
      key: 'tool-image-cache',
      kind: 'cache',
      coldTtlMs: TOOL_IMAGE_CACHE_TTL_MS,
      priority: 10,
    })
    expect((resource.estimatedBytes as () => number)()).toBe(5)
    expect((resource.protection as () => { protected: boolean; reasons: string[] })()).toEqual({
      protected: false,
      reasons: [],
    })

    clearEphemeralToolImages()
    expect(reclaimH.unregisterReclaimable).toHaveBeenCalledWith('tool-image-cache')
  })

  it('evicts expired cache entries without reads', () => {
    mcpResultToChatToolOutput({ content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }] })
    const resource = reclaimH.registered[0]!
    expect(getEphemeralToolImageCacheSnapshot()).toEqual({ entries: 1, bytes: 5 })

    vi.advanceTimersByTime(TOOL_IMAGE_CACHE_TTL_MS + 1)
    ;(resource.evict as (mode?: string) => void)()
    expect(getEphemeralToolImageCacheSnapshot()).toEqual({ entries: 0, bytes: 0 })
  })

  it('hard eviction respects the hard trim byte budget', () => {
    const chunk = Buffer.alloc(512 * 1024)
    for (let i = 0; i < 40; i++) {
      chunk.fill(i & 0xff)
      mcpResultToChatToolOutput({
        content: [{ type: 'image', data: chunk.toString('base64'), mimeType: 'image/png' }],
      })
    }
    const before = getEphemeralToolImageCacheSnapshot()
    expect(before.bytes).toBeGreaterThan(TOOL_IMAGE_CACHE_HARD_TRIM_BYTES)

    ;(reclaimH.registered[0]!.evict as (mode?: string) => void)('hard')
    const after = getEphemeralToolImageCacheSnapshot()
    expect(after.bytes).toBeLessThanOrEqual(TOOL_IMAGE_CACHE_HARD_TRIM_BYTES)
    expect(after.entries).toBeLessThan(before.entries)
  })
})
