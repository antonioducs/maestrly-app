import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  bundleMissingInputs,
  RELEASE_BUILD_INPUTS,
  releaseBuildConfigErrors,
} from '../../scripts/check-release-build-config.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const script = path.join(root, 'scripts/check-release-build-config.mjs')
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const yaml = createRequire(desktopRequire.resolve('electron-updater/package.json'))('js-yaml')
const read = (file) => readFileSync(path.join(root, file), 'utf8')

const CLIENT_ID = 'Ov23liFixtureClient0'
const validEnv = Object.fromEntries(RELEASE_BUILD_INPUTS.map((input) => [input.env, CLIENT_ID]))
const fromVariable = (input) => `\${{ vars.${input.variable} }}`

function runCheck(args, env) {
  const inherited = { ...process.env }
  for (const input of RELEASE_BUILD_INPUTS) delete inherited[input.env]
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...inherited, ...env } })
}

function bundleFixture(t, contents) {
  const directory = mkdtempSync(path.join(tmpdir(), 'maestrly-release-build-config-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(path.join(directory, 'chunks'))
  writeFileSync(path.join(directory, 'index.js'), 'const __vite_import_meta_env__ = {};\n')
  writeFileSync(path.join(directory, 'chunks', 'manager.js'), contents)
  return directory
}

test('GitHub Copilot sign-in is a required release build input wired to the main process', () => {
  const copilot = RELEASE_BUILD_INPUTS.find((input) => input.env === 'MAIN_VITE_GITHUB_COPILOT_CLIENT_ID')
  assert.ok(copilot, 'the Copilot OAuth client ID must be a release build input')
  for (const input of RELEASE_BUILD_INPUTS) {
    // GitHub rejects Actions variable names with the GITHUB_ prefix.
    assert.match(input.variable, /^MAESTRLY_[A-Z0-9_]+$/)
    assert.match(read('apps/desktop/src/main/env.d.ts'), new RegExp(`readonly ${input.env}\\?: string`))
  }
  assert.match(
    read('apps/desktop/src/main/chat/github-copilot/manager.ts'),
    /buildEnv\.MAIN_VITE_GITHUB_COPILOT_CLIENT_ID\b/
  )
})

test('rejects empty, malformed, and secret-shaped client IDs', () => {
  assert.deepEqual(releaseBuildConfigErrors(validEnv), [])
  assert.deepEqual(releaseBuildConfigErrors({ MAIN_VITE_GITHUB_COPILOT_CLIENT_ID: 'Iv1.0123456789abcdef' }), [])
  for (const value of [undefined, '', '   ']) {
    const errors = releaseBuildConfigErrors({ MAIN_VITE_GITHUB_COPILOT_CLIENT_ID: value })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /MAIN_VITE_GITHUB_COPILOT_CLIENT_ID is empty/)
    assert.match(errors[0], /MAESTRLY_GITHUB_COPILOT_CLIENT_ID/)
  }
  for (const value of [`${CLIENT_ID}\n`, ` ${CLIENT_ID}`, 'a'.repeat(40), 'gho_0123456789abcdefghij', '<CLIENT_ID>']) {
    const errors = releaseBuildConfigErrors({ MAIN_VITE_GITHUB_COPILOT_CLIENT_ID: value })
    assert.equal(errors.length, 1, JSON.stringify(value))
    assert.match(errors[0], /is not a GitHub client ID/)
    assert.ok(!errors[0].includes(value.trim()), 'messages must not echo a value that may be a pasted secret')
  }
})

test('the CLI fails without the variable and when the built bundle does not embed it', (t) => {
  const missing = runCheck([], {})
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /MAIN_VITE_GITHUB_COPILOT_CLIENT_ID is empty/)
  assert.equal(runCheck([], validEnv).status, 0)

  const withoutValue = bundleFixture(t, 'export const env = {};\n')
  assert.deepEqual(
    bundleMissingInputs(withoutValue, validEnv).map((input) => input.env),
    ['MAIN_VITE_GITHUB_COPILOT_CLIENT_ID']
  )
  const notEmbedded = runCheck(['--bundle', withoutValue], validEnv)
  assert.equal(notEmbedded.status, 1)
  assert.match(notEmbedded.stderr, /was not embedded/)

  const embedded = bundleFixture(t, `const env = {"MAIN_VITE_GITHUB_COPILOT_CLIENT_ID": "${CLIENT_ID}"};\n`)
  const ok = runCheck(['--bundle', embedded], validEnv)
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(runCheck(['--bundle', embedded], {}).status, 1)
  assert.equal(runCheck(['--bundle'], validEnv).status, 1)
})

test('releases check the inputs before building and every desktop package embeds them', () => {
  const source = read('.github/workflows/release.yml')
  const { jobs } = yaml.load(source)
  const runs = (job) => job.steps.map((step) => step.run ?? '')
  const indexOf = (job, pattern) => runs(job).findIndex((run) => pattern.test(run))

  const validate = jobs.validate
  const guard = indexOf(validate, /^node scripts\/check-release-build-config\.mjs$/)
  assert.ok(guard !== -1, 'the validate job must check the release build configuration')
  assert.ok(guard < indexOf(validate, /^npm ci$/), 'the configuration check must run before installing and building')
  for (const input of RELEASE_BUILD_INPUTS) assert.equal(validate.steps[guard].env?.[input.env], fromVariable(input))

  const packaging = Object.entries(jobs).filter(([, job]) => job.steps && indexOf(job, /npm run package/) !== -1)
  assert.deepEqual(packaging.map(([name]) => name).sort(), ['linux', 'macos', 'windows'])
  for (const [name, job] of packaging) {
    for (const input of RELEASE_BUILD_INPUTS) assert.equal(job.env?.[input.env], fromVariable(input), name)
    const built = indexOf(job, /npm run package/)
    const verified = indexOf(job, /^node scripts\/check-release-build-config\.mjs --bundle apps\/desktop\/out\/main$/)
    const staged = indexOf(job, /stage-release-assets\.mjs/)
    assert.ok(built < verified && verified < staged, `${name} must verify the built bundle before staging assets`)
  }
  for (const input of RELEASE_BUILD_INPUTS) {
    assert.doesNotMatch(source, new RegExp(`secrets\\.${input.variable}`), 'public client IDs are variables')
  }
})
