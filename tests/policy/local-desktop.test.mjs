import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : /\.(?:ts|tsx|mjs)$/.test(file) ? [file] : []
  })
}

test('desktop source has no hosted Maestrly backend or diagnostic transport', () => {
  const forbidden = /https?:\/\/[^\s'"`]*(?:supabase\.(?:co|com)|aptabase\.com|ingest\.sentry\.io)|(?:from\s*|import\s*)['"](?:@supabase\/|@sentry\/)/i
  for (const file of sourceFiles(path.join(root, 'apps/desktop/src'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, path.relative(root, file))
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.doesNotMatch(dependency, /^@(?:supabase|sentry)\//)
  }
})

test('tracked first-party metadata uses the project identity', () => {
  assert.equal(existsSync(path.join(root, 'AGENTS.md')), false)
  assert.match(readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Maestrly App contributors/)
  assert.match(
    readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8'),
    /Maestrly contributors <noreply@maestrly\.com>/
  )
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  assert.equal(manifest.author, 'Maestrly contributors')
})

test('preload does not expose retired Maestrly account or cloud endpoints', () => {
  const forbidden = /ipcRenderer\.(?:invoke|send|on)\(\s*['"](?:auth:|license:|legal:|account:|cloud-project:|telemetry:|feedback:|update:)/
  for (const file of sourceFiles(path.join(root, 'apps/desktop/src/preload'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, path.relative(root, file))
  }
})
