import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflows = path.join(root, '.github', 'workflows')

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8')
}

test('GitHub Actions use immutable revisions with version comments', () => {
  for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
    const source = readFileSync(path.join(workflows, file), 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      const match = /^\s*-\s+uses:\s*([^\s#]+)(?:\s+#\s*(.+))?$/.exec(line)
      if (!match || match[1].startsWith('./') || match[1].startsWith('docker://')) continue
      const separator = match[1].lastIndexOf('@')
      const revision = separator >= 0 ? match[1].slice(separator + 1) : ''
      assert.match(revision, /^[0-9a-f]{40}$/, `${file}:${index + 1} must pin a full commit SHA`)
      assert.match(match[2] ?? '', /^v\d+(?:\.\d+){0,2}\b/, `${file}:${index + 1} must retain a version comment`)
    }
  }
})

test('main ruleset has no bypass and requires every stable check', () => {
  const ruleset = JSON.parse(read('.github/rulesets/main.json'))
  assert.equal(ruleset.name, 'Protect main')
  assert.equal(ruleset.target, 'branch')
  assert.equal(ruleset.enforcement, 'active')
  assert.deepEqual(ruleset.bypass_actors, [])
  assert.deepEqual(ruleset.conditions.ref_name, { exclude: [], include: ['~DEFAULT_BRANCH'] })

  const rules = new Map(ruleset.rules.map((rule) => [rule.type, rule]))
  for (const type of ['deletion', 'non_fast_forward', 'required_linear_history']) assert.ok(rules.has(type), type)
  const pullRequest = rules.get('pull_request')?.parameters
  assert.equal(pullRequest?.required_approving_review_count, 0)
  assert.equal(pullRequest?.required_review_thread_resolution, true)
  assert.deepEqual(pullRequest?.allowed_merge_methods, ['squash'])

  const contexts = rules
    .get('required_status_checks')
    ?.parameters.required_status_checks.map((check) => check.context)
    .sort()
  assert.deepEqual(contexts, ['Dependency policy', 'Linux', 'Secret history', 'Windows', 'macOS'].sort())
})

test('package smoke runs only on schedule or manual dispatch and cannot publish', () => {
  const source = read('.github/workflows/package-smoke.yml')
  const triggerBlock = /^on:\n([\s\S]*?)^permissions:/m.exec(source)?.[1] ?? ''
  const triggers = [...triggerBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]).sort()

  assert.deepEqual(triggers, ['schedule', 'workflow_dispatch'])
  assert.doesNotMatch(source, /actions\/upload-artifact|\bgh release\b|--publish|\bnpm publish\b/i)
})

test('release workflow publishes verified native artifacts only from version tags', () => {
  const source = read('.github/workflows/release.yml')
  const triggerBlock = /^on:\n([\s\S]*?)^permissions:/m.exec(source)?.[1] ?? ''
  const triggers = [...triggerBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]).sort()

  assert.deepEqual(triggers, ['push'])
  assert.match(triggerBlock, /^    tags:\n      - "v\*"$/m)
  assert.doesNotMatch(triggerBlock, /pull_request|pull_request_target|workflow_dispatch/)
  assert.match(source, /^permissions:\n  contents: read$/m)
  assert.match(source, /^concurrency:\n  group: release-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m)

  assert.match(source, /^  macos:\n[\s\S]*?^    runs-on: macos-15$/m)
  assert.match(source, /^  macos:\n[\s\S]*?^    environment: release$/m)
  assert.match(source, /npm run package:linux/)
  assert.match(source, /npm run package:win/)
  assert.match(source, /npm run package:release/)
  assert.equal((source.match(/npm run smoke:packaged-desktop/g) ?? []).length, 3)
  assert.equal((source.match(/npm run smoke:packaged-local-ml-runtime/g) ?? []).length, 3)
  assert.match(source, /name: release-linux/)
  assert.match(source, /name: release-windows/)
  assert.match(source, /name: release-macos/)

  assert.match(source, /^  publish:\n    name: Publish GitHub Release\n    needs: \[validate, linux, windows, macos\]$/m)
  assert.match(source, /^  publish:\n[\s\S]*?^    permissions:\n      contents: write$/m)
  assert.match(source, /gh release create "\$GITHUB_REF_NAME"/)
  assert.match(source, /--draft/)
  assert.match(source, /--generate-notes/)
  assert.match(source, /sha256sum --check SHA256SUMS\.txt/)
  assert.match(source, /gh release edit "\$GITHUB_REF_NAME" --draft=false/)
  assert.doesNotMatch(source, /--clobber|\bnpm publish\b|\belectron-builder\b|--publish/)

  assert.match(source, /if: always\(\)/)
  assert.match(source, /security delete-keychain/)
  assert.match(source, /developer-id\.p12/)
  assert.match(source, /AuthKey_\$\{APPLE_API_KEY_ID\}\.p8/)
})

test('CI is read-only and exposes stable platform names', () => {
  const source = read('.github/workflows/ci.yml')
  assert.match(source, /^permissions:\n  contents: read$/m)
  const platforms = [...source.matchAll(/^\s+- label: (Linux|macOS|Windows)$/gm)].map((match) => match[1]).sort()
  assert.deepEqual(platforms, ['Linux', 'Windows', 'macOS'].sort())
  assert.match(source, /check-commits\.mjs --subject-env PR_TITLE/)
})

test('contribution policy preserves truthful authorship and standard commit metadata', () => {
  const source = [read('CONTRIBUTING.md'), read('docs/repository-governance.md')].join('\n')
  assert.match(source, /truthful (?:commit )?authorship|truthful Git identity/)
  assert.match(source, /Pull requests are welcome from any GitHub account|Anyone may open a pull request/)
  assert.match(source, /bodies.*(?:trailers|attribution)|Bodies.*Co-authored-by/s)
  assert.doesNotMatch(source, /commits must use `antonioducs`|Only the `antonioducs` account may open/)
})

test('packages include synchronized project and runtime license notices', () => {
  const builder = read('electron-builder.yml')
  assert.match(builder, /- from: LICENSE\n\s+to: LICENSE\.txt/)
  assert.match(builder, /- from: THIRD_PARTY_NOTICES\.md\n\s+to: THIRD_PARTY_NOTICES\.md/)

  const manifest = JSON.parse(read('package.json'))
  const notices = read('THIRD_PARTY_NOTICES.md')
  const codexNotice = read('resources/licenses/openai-codex-runtime-NOTICE.txt')
  assert.ok(notices.includes('`@openai/codex` ' + manifest.devDependencies['@openai/codex']))
  assert.ok(codexNotice.includes('Version: ' + manifest.devDependencies['@openai/codex']))
})

test('dependency policy covers the packaged local ML closure', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.match(manifest.scripts['audit:dependencies'], /--prefix runtime-assets\/local-ml/)

  const runtimeManifest = JSON.parse(read('runtime-assets/local-ml/package.json'))
  assert.equal(runtimeManifest.overrides.sharp, '0.35.4')
})

test('Gitleaks uses only constrained current-tree exceptions', () => {
  const source = read('.gitleaks.toml')
  assert.match(source, /^\[extend\]\nuseDefault = true$/m)
  assert.doesNotMatch(source, /^commits\s*=/m)
  assert.equal(existsSync(path.join(root, '.gitleaksignore')), false)
  assert.equal((source.match(/targetRules = \["generic-api-key"\]/g) ?? []).length, 2)
  assert.equal((source.match(/condition = "AND"/g) ?? []).length, 2)
  assert.equal((source.match(/regexTarget = "line"/g) ?? []).length, 2)
  assert.match(source, /chat-chatgpt-web-\(\?:bridge\|router\)/)
  assert.doesNotMatch(source, /paths\s*=\s*\[\s*'''\^test\/\.\*'''/)
})
