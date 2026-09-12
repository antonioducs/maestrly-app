/** `write` tool — ported from opencode tool/write.ts. Creates/overwrites preserving BOM. "edit" gate. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool, hasUtf8Bom, resolveInside, stripBom, withFileLock, type ToolContext } from './util'

const params = z.object({
  path: z.string().describe('Path of the file to write (relative to the cwd, or absolute).'),
  content: z.string().describe('Full file contents.'),
})

interface WriteResult {
  resource: string
  existed: boolean
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<WriteResult> {
  const { abs, external } = resolveInside(ctx.cwd, args.path)
  if (external) await ctx.ask('external_directory', [abs], [abs])
  await ctx.ask('edit', [abs], ['*'])

  return withFileLock(abs, async () => {
    const existingBuf = await fs.readFile(abs).catch(() => null)
    const existed = existingBuf != null
    const hadBom = existed && hasUtf8Bom(existingBuf!)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const stripped = stripBom(args.content)
    await fs.writeFile(abs, hadBom ? '﻿' + stripped : stripped, 'utf8')
    return { resource: path.relative(ctx.cwd, abs) || path.basename(abs), existed }
  })
}

export const writeTool = defineTool({
  name: 'write',
  description: 'Creates or overwrites a file with the given contents. For targeted edits prefer the edit tool.',
  parameters: params,
  execute: run,
  toModelText: (_args, r) => `${r.existed ? 'File overwritten' : 'File created'}: ${r.resource}`,
})
