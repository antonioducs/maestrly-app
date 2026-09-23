import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { assertBundledZlib, sharedZlibProblem } from '../../scripts/local-ml-toolchain.mjs'

const root = path.resolve(import.meta.dirname, '../..')

test('official Node.js builds with bundled zlib may build Local ML archives', () => {
  for (const config of [{ variables: { node_shared_zlib: false } }, { variables: { node_shared_zlib: 'false' } }, {}]) {
    assert.equal(sharedZlibProblem({ config, versions: { zlib: '1.3.1-e00f703' }, execPath: '/official/node' }), null)
    assert.doesNotThrow(() => assertBundledZlib({ config, versions: {}, execPath: '/official/node' }))
  }
})

test('Node.js builds linking the system zlib are refused with actionable guidance', () => {
  for (const shared of [true, 'true']) {
    const options = {
      config: { variables: { node_shared_zlib: shared } },
      versions: { zlib: '1.2.12' },
      execPath: '/opt/homebrew/bin/node',
    }
    const problem = sharedZlibProblem(options)
    assert.match(problem, /\/opt\/homebrew\/bin\/node links a shared system zlib \(1\.2\.12\)/)
    assert.match(problem, /apps\/desktop\/runtime-assets\/local-ml\/manifest\.json/)
    assert.match(problem, /official Node\.js build that matches \.nvmrc/)
    assert.throws(() => assertBundledZlib(options), { message: problem })
  }
})

test('Local ML build checks the toolchain before installing dependencies or writing the manifest', () => {
  const source = readFileSync(path.join(root, 'scripts/build-local-ml-runtime.mjs'), 'utf8')
  const check = source.indexOf('\nassertBundledZlib()')
  assert.ok(check > 0)
  assert.ok(check < source.indexOf('\nensureLocalMlDependencies('))
  assert.ok(check < source.indexOf('await writeFile(manifestPath'))
})

test('toolchain preflight exits with the result for the running Node.js', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['check:local-ml-toolchain'], 'node scripts/local-ml-toolchain.mjs')
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/local-ml-toolchain.mjs')], { encoding: 'utf8' })
  if (sharedZlibProblem()) {
    assert.equal(result.status, 1)
    assert.match(result.stderr, /\[local-ml-toolchain\] .*links a shared system zlib/)
  } else {
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\[local-ml-toolchain\] ok: .* bundles zlib /)
  }
})
