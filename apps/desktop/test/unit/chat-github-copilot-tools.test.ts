import { jsonSchema, tool, type ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type { Tool as CopilotTool } from '@github/copilot-sdk'
import { toolOutputImages } from '../../src/shared/chat'
import { copilotTools, mergeCopilotToolSets, profileCopilotTools } from '../../src/main/chat/github-copilot/tools'
import { chatToolOutputToAiSdkOutput, mcpResultToChatToolOutput } from '../../src/main/chat/tool-output'

function namedTool(owner: string, execute = vi.fn(async () => owner)) {
  return tool({
    description: `${owner} implementation`,
    inputSchema: jsonSchema<{ value?: string }>({
      type: 'object',
      properties: { value: { type: 'string' } },
      additionalProperties: false,
    }),
    execute,
  })
}

async function invoke(entry: CopilotTool): Promise<unknown> {
  return entry.handler?.({}, { toolCallId: 'call-1' } as never)
}

describe('GitHub Copilot tool conversion', () => {
  it('applies selective deferral without changing precedence or dispatch on collisions', async () => {
    const core: ToolSet = {
      core_only: namedTool('core-only'),
      mcp_core: namedTool('core-collision'),
      shared: namedTool('core-shared'),
    }
    const mcp: ToolSet = {
      mcp_only: namedTool('mcp-only'),
      mcp_search: namedTool('mcp-search'),
      mcp_call: namedTool('mcp-call'),
      mcp_core: namedTool('mcp-collision'),
      app_collision: namedTool('mcp-app-collision'),
      shared: namedTool('mcp-shared'),
    }
    const app: ToolSet = {
      drawer_only: namedTool('drawer-only'),
      app_collision: namedTool('app-collision'),
      skill_app: namedTool('app-skill-collision'),
      shared: namedTool('app-shared'),
    }
    const skill: ToolSet = {
      use_skill: namedTool('skill-only'),
      skill_app: namedTool('skill-collision'),
      shared: namedTool('skill-shared'),
    }
    const task: ToolSet = {
      task: namedTool('task-only'),
      review_plan: namedTool('review-plan'),
      shared: namedTool('task-shared'),
    }
    const merged = mergeCopilotToolSets(core, mcp, app, skill, task)
    const converted = await copilotTools(merged.tools, new AbortController().signal, merged.deferredToolNames)
    const byName = new Map(converted.map((entry) => [entry.name, entry]))

    for (const name of ['mcp_only', 'mcp_search', 'mcp_call', 'mcp_core', 'drawer_only', 'app_collision']) {
      expect(byName.get(name)?.defer, name).toBe('auto')
    }
    for (const name of ['core_only', 'use_skill', 'skill_app', 'task', 'review_plan', 'shared']) {
      expect(byName.get(name)?.defer, name).toBe('never')
    }

    await expect(invoke(byName.get('mcp_core')!)).resolves.toBe('mcp-collision')
    await expect(invoke(byName.get('app_collision')!)).resolves.toBe('app-collision')
    await expect(invoke(byName.get('skill_app')!)).resolves.toBe('skill-collision')
    await expect(invoke(byName.get('shared')!)).resolves.toBe('task-shared')
  })

  it('generates a deterministic aggregate profile consistent with the serialized payload', () => {
    const tools: CopilotTool[] = [
      {
        name: 'deferred',
        description: 'drawer tool',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        defer: 'auto',
        handler: vi.fn(),
      },
      {
        name: 'eager',
        description: 'core',
        parameters: { type: 'object' },
        defer: 'never',
        handler: vi.fn(),
      },
    ]

    const profile = profileCopilotTools(tools)
    expect(profileCopilotTools([...tools].reverse())).toEqual(profile)
    expect(profile).toMatchObject({
      total: 2,
      eager: 1,
      deferred: 1,
      largestDescriptionBytes: Buffer.byteLength('drawer tool', 'utf8'),
    })
    expect(profile.serializedBytes).toBeGreaterThan(profile.schemaBytes + profile.descriptionBytes)
    expect(JSON.stringify(profile)).not.toContain('drawer tool')
    expect(JSON.stringify(profile)).not.toContain('path')
  })

  it('keeps canonical image output separate from the Copilot projection without vision', async () => {
    for (const supportsImages of [false, true]) {
      const rawOutput = mcpResultToChatToolOutput({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      })
      if (typeof rawOutput === 'string' || !rawOutput.images?.[0]) throw new Error('expected image output')
      for (const isError of [false, true]) {
        const canonicalOutput = {
          ...rawOutput,
          text: isError ? 'Screenshot failed.' : rawOutput.text,
          images: rawOutput.images.map((image) => ({ ...image, description: 'A small screenshot.' })),
          ...(isError ? { isError: true } : {}),
        }
        const seenCanonical: unknown[] = []
        const [converted] = await copilotTools(
          {
            screenshot: tool({
              description: 'Capture a screenshot.',
              inputSchema: jsonSchema({ type: 'object', properties: {} }),
              execute: async () => canonicalOutput,
              toModelOutput: ({ output }) => chatToolOutputToAiSdkOutput(output, { dropImages: !supportsImages }),
            }),
          },
          new AbortController().signal,
          new Set(),
          (_toolCallId, output) => seenCanonical.push(output)
        )
        const providerResult = await converted!.handler?.({}, {
          toolCallId: `copilot-image-${supportsImages}-${isError}`,
        } as never)
        expect(toolOutputImages(seenCanonical[0] as never)).toHaveLength(1)
        expect(seenCanonical[0]).toMatchObject({
          ...(isError ? { isError: true } : {}),
          images: [{ description: 'A small screenshot.' }],
        })
        if (supportsImages) {
          expect(providerResult).toMatchObject({
            binaryResultsForLlm: [{ data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' }],
            resultType: isError ? 'failure' : 'success',
          })
        } else if (isError) {
          expect(providerResult).toMatchObject({
            resultType: 'failure',
            error: expect.stringContaining('Screenshot failed.'),
          })
          expect(JSON.stringify(providerResult)).toContain('A small screenshot.')
          expect(JSON.stringify(providerResult)).not.toContain('aGVsbG8=')
        } else {
          expect(providerResult).toEqual(expect.stringContaining('A small screenshot.'))
          expect(JSON.stringify(providerResult)).not.toContain('aGVsbG8=')
        }
      }
    }
  })
})
