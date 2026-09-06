import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')

test('local ML archive smoke releases native libraries before deleting its temporary tree', () => {
  const source = readFileSync(path.join(root, 'scripts/smoke-local-ml-runtime.mjs'), 'utf8')

  assert.match(source, /process\.argv\[2\] === '--verify-extracted'/)
  assert.match(
    source,
    /spawn\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), '--verify-extracted', temporary\]/
  )
  assert.match(source, /child\.once\('exit'/)
  assert.match(source, /await verifyExtractedRuntime\(path\.resolve\(process\.argv\[3\]\)\)/)
})

test('packaged local ML smoke selects the named Linux executable instead of shared libraries', () => {
  const source = readFileSync(path.join(root, 'scripts/smoke-packaged-local-ml-runtime.mjs'), 'utf8')

  assert.match(
    source,
    /if \(packagedPlatform === 'linux'\) \{[\s\S]*?path\.join\(unpackedRoot, 'maestrly-app'\)/
  )
  assert.match(source, /process\.platform === 'linux'\s+\? \['--no-sandbox'\]/)
})
