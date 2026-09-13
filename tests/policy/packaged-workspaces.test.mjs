import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { missingWorkspaceBuilds } from '../../scripts/verify-packaged-workspaces.mjs'

const names = ['protocol', 'client-sdk', 'runner-core']
const entries = names.flatMap((name) => [
  `/node_modules/@maestrly/${name}/package.json`,
  `/node_modules/@maestrly/${name}/dist/index.js`,
])

test('accepts compiled workspace packages in the archive', () => {
  assert.deepEqual(missingWorkspaceBuilds(entries), [])
})

test('rejects source-only workspace packages shipped by v0.4.2', () => {
  const sourceOnly = entries.filter((entry) => !entry.endsWith('.js'))
  assert.deepEqual(
    missingWorkspaceBuilds(sourceOnly),
    names.map((name) => `node_modules/@maestrly/${name}/dist/index.js`)
  )
})

test('rejects an individually missing workspace build', () => {
  assert.deepEqual(missingWorkspaceBuilds(entries.filter((entry) => !entry.includes('protocol/dist'))), [
    'node_modules/@maestrly/protocol/dist/index.js',
  ])
})

test('package wrapper compiles workspace dependencies before Electron build', () => {
  const source = readFileSync(new URL('../../scripts/package.mjs', import.meta.url), 'utf8')
  const dependencies = source.indexOf("['run', 'build:runner-core']")
  const desktop = source.indexOf("runPackageBin('electron-vite'")
  assert.ok(dependencies >= 0 && dependencies < desktop)
})
