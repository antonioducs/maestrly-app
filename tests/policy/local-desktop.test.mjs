import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
  assert.match(readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Maestrly App contributors/)
  assert.match(
    readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8'),
    /Maestrly contributors <noreply@maestrly\.com>/
  )
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'))
  assert.equal(manifest.author, 'Maestrly contributors')
})

// `update:` stays allowed: the in-app updater reads public GitHub Releases, with no hosted backend,
// account or telemetry behind it. Every other retired cloud prefix remains forbidden.
test('preload does not expose retired Maestrly account or cloud endpoints', () => {
  const forbidden = /ipcRenderer\.(?:invoke|send|on)\(\s*['"](?:auth:|license:|legal:|account:|cloud-project:|telemetry:|feedback:)/
  for (const file of sourceFiles(path.join(root, 'apps/desktop/src/preload'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, path.relative(root, file))
  }
})

// Electron 44 no longer runs on macOS 12. Resolve each channel as electron-builder does, including `extends`.
test('every macOS package channel declares the macOS 13 minimum', async () => {
  const desktop = path.join(root, 'apps/desktop')
  const { getConfig } = createRequire(path.join(desktop, 'package.json'))('app-builder-lib/out/util/config/config')
  const channels = readdirSync(desktop).filter((file) => /^electron-builder(?:\.[a-z.]+)?\.yml$/.test(file))
  assert.deepEqual(channels.sort(), [
    'electron-builder.beta.yml',
    'electron-builder.dev.yml',
    'electron-builder.release.beta.yml',
    'electron-builder.release.yml',
    'electron-builder.yml',
  ])
  for (const file of channels) {
    const config = await getConfig(desktop, path.join(desktop, file), null)
    assert.equal(config.mac?.minimumSystemVersion, '13.0.0', file)
  }
})
