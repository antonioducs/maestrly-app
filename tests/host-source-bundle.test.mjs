import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { bundleHostSource } from '../scripts/host-source-bundle.mjs'

test('actual daemon CLI uses current core/protocol source rather than workspace dist', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = await bundleHostSource(root, 'apps/host/src/cli.ts', { write: false, metafile: true })
  const inputs = Object.keys(result.metafile.inputs)
  assert(inputs.some(p => p.endsWith('host-core/src/guest/install.ts')))
  assert(inputs.some(p => p.endsWith('host-protocol/src/bot-rpc.ts')))
  assert(!inputs.some(p => /host-(core|protocol)\/dist\//.test(p)))
  assert.match(result.outputFiles[0].text, /mode: "wb"/)
  assert.doesNotMatch(result.outputFiles[0].text, /mode: "wx"/)
})
