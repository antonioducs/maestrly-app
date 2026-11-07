import { tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ANTIGRAVITY_TOOL_SCHEMAS_TOOL,
  antigravityToolSchemasText,
  antigravityToolSignature,
  type HostToolSpec,
  hostToolSpecs,
  planAntigravityToolCatalog,
  renderAntigravityToolCatalog,
} from '../../src/main/chat/antigravity-subscription/tool-catalog'

const echo = tool({
  description: 'Echo text back.',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
})
const add = tool({
  description: 'Add two numbers.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => String(a + b),
})

describe('Antigravity tool catalog', () => {
  it('lists executable tools sorted by name with their JSON schemas', async () => {
    const specs = await hostToolSpecs({ zeta: echo, add, notExecutable: { description: 'x' } as never })
    expect(specs.map((spec) => spec.name)).toEqual(['add', 'zeta'])
    expect(specs[1]).toMatchObject({
      name: 'zeta',
      description: 'Echo text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    })
  })

  it('changes the signature when a schema changes, not only a name', async () => {
    const base = antigravityToolSignature(await hostToolSpecs({ echo }))
    const same = antigravityToolSignature(await hostToolSpecs({ echo }))
    const widened = antigravityToolSignature(
      await hostToolSpecs({
        echo: tool({
          description: 'Echo text back.',
          inputSchema: z.object({ text: z.string(), loud: z.boolean().optional() }),
          execute: async ({ text }) => text,
        }),
      })
    )
    expect(same).toBe(base)
    expect(widened).not.toBe(base)
  })

  it('renders names, descriptions, and exact schemas for the first prompt', async () => {
    const catalog = renderAntigravityToolCatalog(await hostToolSpecs({ echo }))
    expect(catalog.startsWith('<maestrly_tools>\n')).toBe(true)
    expect(catalog.endsWith('\n</maestrly_tools>')).toBe(true)
    expect(catalog).toContain('- maestrly_echo: Echo text back.')
    expect(catalog).toContain('"properties":{"text":{"type":"string"}}')
    expect(catalog).toContain('Built-in Antigravity tools are disabled')
  })
})

/** A synthetic tool whose description and schema take roughly `bytes`. */
function bulky(name: string, bytes = 2_000): HostToolSpec {
  return {
    name,
    description: `Runs ${name} on the synthetic server. ${'More detail about it. '.repeat(Math.ceil(bytes / 44))}`,
    inputSchema: {
      type: 'object',
      properties: { input: { type: 'string', description: 'x'.repeat(Math.ceil(bytes / 2)) } },
    },
  }
}

const core = [bulky('read', 500), bulky('write', 500)]
const app = Array.from({ length: 10 }, (_, index) => bulky(`app_${index}`))
const mcp = Array.from({ length: 30 }, (_, index) => bulky(`mcp_${index}`))
const tiers = [mcp.map((spec) => spec.name), app.map((spec) => spec.name)]
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

describe('Antigravity tool catalog budget', () => {
  it('keeps every schema while the catalog fits its budget', () => {
    const plan = planAntigravityToolCatalog([...core, ...app], tiers, 100_000)
    expect(plan.summarized.size).toBe(0)
    expect(plan.specs.map((spec) => spec.name)).not.toContain(ANTIGRAVITY_TOOL_SCHEMAS_TOOL)
    expect(plan.catalog).toBe(renderAntigravityToolCatalog([...core, ...app]))
  })

  it('lists the first tier without schemas and serves them through get_tool_schemas', () => {
    const plan = planAntigravityToolCatalog([...core, ...app, ...mcp], tiers, 40_000)
    expect([...plan.summarized].sort()).toEqual(tiers[0].slice().sort())
    expect(bytes(plan.catalog)).toBeLessThanOrEqual(40_000)
    expect(plan.specs.map((spec) => spec.name)).toContain(ANTIGRAVITY_TOOL_SCHEMAS_TOOL)
    expect(plan.catalog).toContain('- maestrly_mcp_0: Runs mcp_0 on the synthetic server.\n')
    expect(plan.catalog).not.toContain('maestrly_mcp_0: Runs mcp_0 on the synthetic server. More detail')
    expect(plan.catalog).toMatch(/- maestrly_app_0: .+\n {2}arguments: /)
    expect(plan.catalog).toMatch(/- maestrly_get_tool_schemas: .+\n {2}arguments: /)
    expect(plan.catalog).toContain('call maestrly_get_tool_schemas with its name')
  })

  it('moves to the next tier only when the first is not enough, and never summarizes tools outside the tiers', () => {
    const plan = planAntigravityToolCatalog([...core, ...app, ...mcp], tiers, 8_000)
    expect(plan.summarized.size).toBe(mcp.length + app.length)
    expect(plan.catalog).toMatch(/- maestrly_read: .+\n {2}arguments: /)
    expect(plan.catalog).toMatch(/- maestrly_write: .+\n {2}arguments: /)
    expect(plan.catalog).not.toMatch(/- maestrly_app_0: .+\n {2}arguments: /)
  })

  it('lists deferred tools without schemas even when the whole catalog would fit', () => {
    const deferredNames = app.map((spec) => spec.name)
    const plan = planAntigravityToolCatalog([...core, ...app], tiers, 100_000, deferredNames)
    expect([...plan.summarized].sort()).toEqual(deferredNames.slice().sort())
    expect(plan.specs.map((spec) => spec.name)).toContain(ANTIGRAVITY_TOOL_SCHEMAS_TOOL)
    expect(plan.catalog).toMatch(/- maestrly_read: .+\n {2}arguments: /)
    expect(plan.catalog).not.toMatch(/- maestrly_app_0: .+\n {2}arguments: /)
    // Every deferred tool is still named, so the model knows it exists and can ask for its schema.
    for (const name of deferredNames) expect(plan.catalog).toContain(`- maestrly_${name}: `)
    expect(bytes(plan.catalog)).toBeLessThan(bytes(renderAntigravityToolCatalog([...core, ...app])))
  })

  it('still gives up the tiers once the deferred tools are not enough', () => {
    const deferredNames = app.map((spec) => spec.name)
    const plan = planAntigravityToolCatalog([...core, ...app, ...mcp], tiers, 40_000, deferredNames)
    expect(plan.summarized.size).toBe(mcp.length + app.length)
    expect(bytes(plan.catalog)).toBeLessThanOrEqual(40_000)
  })

  it('ignores deferred names the catalog does not serve', () => {
    const plan = planAntigravityToolCatalog(core, [], 100_000, ['gone'])
    expect(plan.summarized.size).toBe(0)
    expect(plan.catalog).toBe(renderAntigravityToolCatalog(core))
  })

  it('shortens long single-sentence descriptions in the summary', () => {
    const long: HostToolSpec = { name: 'mcp_long', description: 'word '.repeat(200), inputSchema: { type: 'object' } }
    const plan = planAntigravityToolCatalog([...core, long, ...mcp], [['mcp_long', ...tiers[0]]], 1_000)
    const line = plan.catalog.split('\n').find((entry) => entry.startsWith('- maestrly_mcp_long: '))
    expect(line?.endsWith('…')).toBe(true)
    expect(line!.length).toBeLessThan(200)
  })

  it('changes the signature when the summarized tools change', () => {
    const specs = [...core, ...mcp]
    expect(antigravityToolSignature(specs)).not.toBe(antigravityToolSignature(specs, ['mcp_0']))
    expect(antigravityToolSignature(specs, ['mcp_1', 'mcp_0'])).toBe(
      antigravityToolSignature(specs, ['mcp_0', 'mcp_1'])
    )
  })

  it('returns full entries for known tools, with or without the server prefix, and names unknown ones', () => {
    const text = antigravityToolSchemasText([...core, ...mcp], { names: ['maestrly_mcp_3', 'read', 'nope'] })
    expect(text).toContain('- maestrly_mcp_3: Runs mcp_3 on the synthetic server. More detail')
    expect(text).toMatch(/- maestrly_read: .+\n {2}arguments: \{"type":"object",/)
    expect(text).toContain('Unknown tools: nope.')
    expect(antigravityToolSchemasText(core, {})).toMatch(/Pass the tool names/)
  })
})
