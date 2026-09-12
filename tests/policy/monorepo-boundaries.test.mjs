import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const products = ['desktop', 'web', 'server', 'runner']
const libraries = ['protocol', 'client-sdk', 'runner-core']

function sourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : /\.(?:ts|tsx|mjs)$/.test(file) ? [file] : []
  })
}

test('the repository exposes four independent applications and focused packages', () => {
  const workspace = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.deepEqual(workspace.workspaces, ['apps/*', 'packages/*'])
  for (const name of products) assert.equal(existsSync(path.join(root, 'apps', name, 'package.json')), true, name)
  for (const name of libraries) assert.equal(existsSync(path.join(root, 'packages', name, 'package.json')), true, name)
  assert.equal(existsSync(path.join(root, 'packages/shared')), false)
})

test('headless and browser packages do not import Electron or desktop implementation code', () => {
  const scoped = [
    ...products.filter((name) => name !== 'desktop').map((name) => path.join(root, 'apps', name, 'src')),
    ...libraries.map((name) => path.join(root, 'packages', name, 'src')),
  ]
  const forbidden = /(?:from\s*|import\s*\()['"](?:electron|@maestrly\/desktop|(?:\.\.\/)+apps\/desktop)/
  for (const directory of scoped) {
    for (const file of sourceFiles(directory)) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, path.relative(root, file))
    }
  }
})

test('server owns domain persistence and clients depend only on public contracts', () => {
  for (const packageName of ['protocol', 'client-sdk', 'runner-core']) {
    const manifest = JSON.parse(readFileSync(path.join(root, 'packages', packageName, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies?.['@maestrly/server'], undefined, packageName)
  }
  const serverSources = sourceFiles(path.join(root, 'apps/server/src'))
  assert.ok(serverSources.some((file) => file.includes(`${path.sep}db${path.sep}`)))
})
