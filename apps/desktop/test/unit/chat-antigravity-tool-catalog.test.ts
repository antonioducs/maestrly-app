import { tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  antigravityToolSignature,
  hostToolSpecs,
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
