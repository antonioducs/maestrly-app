import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  CURSOR_SDK_VERSION,
  extractPackage,
  installTarget,
  main,
  parseArgs,
  platformPackageSuffixesToPrune,
  resolveCursorSdk,
  TARGETS,
  verifyIntegrity,
} from '../../scripts/fetch-cursor-sdk-platform.mjs'
import { archiveEntryPath, verifyPlatformEntries } from '../../scripts/verify-packaged-cursor-sdk.mjs'

function archive(name, type = '0', declaredSize = 5) {
  const header = Buffer.alloc(512)
  header.write(name)
  header.write('0000755\0', 100)
  header.write(`${declaredSize.toString(8).padStart(11, '0')}\0`, 124)
  header.write(type, 156)
  return gzipSync(Buffer.concat([header, Buffer.from('hello'), Buffer.alloc(507)]))
}
function withTemp(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cursor-extract-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
async function withRepo(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cursor-repo-test-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
/** Install a fake SDK at `<repo>/<location>/node_modules/@cursor/sdk`. */
function fakeSdk(repo, location, version = CURSOR_SDK_VERSION) {
  const directory = path.join(repo, location, 'node_modules', '@cursor', 'sdk')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@cursor/sdk', version }))
  return directory
}
function tarball(files) {
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(`package/${name}`)
    header.write('0000755\0', 100)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('0', 156)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat(blocks))
}
const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
test('extracts package files and preserves executable permissions', () =>
  withTemp((dir) => {
    extractPackage(archive('package/bin/rg'), dir)
    assert.equal(readFileSync(path.join(dir, 'bin/rg'), 'utf8'), 'hello')
    if (process.platform !== 'win32') assert.ok(statSync(path.join(dir, 'bin/rg')).mode & 0o111)
  }))
test('rejects traversal, Windows paths, symlinks, and truncated files', () =>
  withTemp((dir) => {
    for (const name of ['package/../escape', 'package/C:/escape', 'package/a\\escape', 'package//escape']) {
      assert.throws(() => extractPackage(archive(name), dir), /Unsafe/)
    }
    assert.throws(() => extractPackage(archive('package/link', '2'), dir), /Unsupported/)
    assert.throws(() => extractPackage(archive('package/file', '0', 4096), dir), /Truncated/)
    assert.throws(() => extractPackage(gzipSync(Buffer.alloc(512)), dir), /no package/)
  }))
test('integrity verification fails before extraction for modified bytes', () => {
  const bytes = archive('package/file')
  const pin = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  verifyIntegrity(bytes, pin)
  assert.throws(() => verifyIntegrity(Buffer.concat([bytes, Buffer.from('x')]), pin), /integrity/)
})
test('cross-target staging prunes the host and all other foreign helpers', () => {
  const { targets } = parseArgs(['--target', 'win-x64', '--prune'])
  assert.deepEqual(
    targets.map((target) => target.npmSuffix),
    ['win32-x64']
  )
  assert.deepEqual(
    platformPackageSuffixesToPrune(targets),
    TARGETS.filter((t) => t.id !== 'win-x64').map((t) => t.npmSuffix)
  )
  verifyPlatformEntries(['/node_modules/@cursor/sdk-win32-x64/package.json'], 'win-x64')
  assert.throws(
    () =>
      verifyPlatformEntries(
        ['/node_modules/@cursor/sdk-win32-x64/package.json', '/node_modules/@cursor/sdk-darwin-arm64/package.json'],
        'win-x64'
      ),
    /Unexpected/
  )
  assert.throws(() => verifyPlatformEntries([], 'win-x64'), /missing/)
})
test('asar entries are matched regardless of the host path separator', () => {
  // listPackage() joins with the host separator, so a Windows run reports backslash entries.
  verifyPlatformEntries(['\\node_modules\\@cursor\\sdk-win32-x64\\package.json'], 'win-x64')
  assert.throws(
    () =>
      verifyPlatformEntries(
        ['\\node_modules\\@cursor\\sdk-win32-x64\\package.json', '\\node_modules\\@cursor\\sdk-darwin-arm64\\bin\\rg'],
        'win-x64'
      ),
    /Unexpected/
  )
  assert.throws(() => verifyPlatformEntries(['\\node_modules\\@cursor\\sdk-win32-x64\\bin\\rg.exe'], 'win-arm64'))
  // asar splits lookups on path.sep, so archive reads must use the host separator.
  assert.equal(archiveEntryPath('node_modules/@cursor/sdk/package.json', '/'), 'node_modules/@cursor/sdk/package.json')
  assert.equal(
    archiveEntryPath('node_modules/@cursor/sdk/package.json', '\\'),
    'node_modules\\@cursor\\sdk\\package.json'
  )
})
test('Windows ARM64 omits helpers without failing the app package', () => {
  assert.deepEqual(parseArgs(['--target=win-arm64', '--prune']), { targets: [], prune: true })
  assert.equal(platformPackageSuffixesToPrune([]).length, TARGETS.length)
  assert.equal(verifyPlatformEntries([], 'win-arm64'), undefined)
  assert.throws(() => verifyPlatformEntries(['/node_modules/@cursor/sdk-win32-x64/bin/rg.exe'], 'win-arm64'))
  assert.throws(() => parseArgs(['--target=linux-riscv64']), /Unsupported/)
})
test('fetcher pins agree with runtime integrity metadata', () => {
  const source = readFileSync(
    new URL('../../apps/desktop/src/main/chat/cursor-sdk/platform.ts', import.meta.url),
    'utf8'
  )
  for (const target of TARGETS) assert.ok(source.includes(target.integrity), target.id)
  assert.ok(source.includes(`CURSOR_SDK_VERSION = '${CURSOR_SDK_VERSION}'`))
  const desktop = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8'))
  assert.equal(desktop.dependencies['@cursor/sdk'], CURSOR_SDK_VERSION)
})

test('platform suffixes match SDK optional dependencies and preserve upstream license', () => {
  // Resolve as apps/desktop does; npm may hoist the SDK or nest it in the workspace.
  const { directory } = resolveCursorSdk()
  const sdk = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  assert.deepEqual(
    Object.keys(sdk.optionalDependencies).sort(),
    TARGETS.map((target) => `@cursor/sdk-${target.npmSuffix}`).sort()
  )
  for (const target of TARGETS) {
    assert.equal(sdk.optionalDependencies[`@cursor/sdk-${target.npmSuffix}`], CURSOR_SDK_VERSION)
  }
  assert.equal(
    readFileSync(new URL('../../apps/desktop/resources/licenses/cursor-sdk-LICENSE.md', import.meta.url), 'utf8'),
    readFileSync(path.join(directory, 'LICENSE.md'), 'utf8')
  )
})

test('resolves the SDK from the desktop workspace, preferring nested over hoisted', () =>
  withTemp((repo) => {
    assert.throws(() => resolveCursorSdk(repo), /not installed for apps\/desktop/)
    const hoisted = fakeSdk(repo, '')
    assert.deepEqual(resolveCursorSdk(repo), {
      directory: hoisted,
      helperRoot: path.join(repo, 'node_modules/@cursor'),
    })
    const nested = fakeSdk(repo, 'apps/desktop')
    assert.deepEqual(resolveCursorSdk(repo), {
      directory: nested,
      helperRoot: path.join(repo, 'apps/desktop/node_modules/@cursor'),
    })
  }))

test('rejects a resolved SDK whose version differs from the pin', async () =>
  withRepo(async (repo) => {
    fakeSdk(repo, '')
    fakeSdk(repo, 'apps/desktop', '1.0.31')
    // The nested copy shadows the hoisted one for apps/desktop, exactly as Node resolves it.
    assert.throws(
      () => resolveCursorSdk(repo),
      new RegExp(`Expected @cursor/sdk ${CURSOR_SDK_VERSION}, found 1\\.0\\.31`)
    )
    const download = () => assert.fail('must not download before the SDK version is validated')
    await assert.rejects(main(['--target=linux-x64'], { repoRoot: repo, fetch: download }), /Expected @cursor\/sdk/)
  }))

test('installs only verified, complete helpers beside a nested SDK', async () =>
  withRepo(async (repo) => {
    fakeSdk(repo, 'apps/desktop')
    const { helperRoot } = resolveCursorSdk(repo)
    const target = TARGETS.find((item) => item.id === 'linux-x64')
    const destination = path.join(helperRoot, 'sdk-linux-x64')
    mkdirSync(destination)
    writeFileSync(path.join(destination, 'previous'), '')
    const manifest = JSON.stringify({ name: '@cursor/sdk-linux-x64', version: CURSOR_SDK_VERSION })
    const complete = { 'package.json': manifest, 'bin/rg': 'rg', 'vendor/tree-sitter/index.js': '' }
    const requested = []
    const serve =
      (bytes, status = 200) =>
      async (url) => {
        requested.push(url)
        return new Response(bytes, { status })
      }
    const pinned = (bytes) => ({ ...target, integrity: sha512(bytes) })
    // The committed pin rejects any other bytes before extraction.
    await assert.rejects(installTarget(target, helperRoot, { fetch: serve(tarball(complete)) }), /integrity mismatch/)
    await assert.rejects(installTarget(target, helperRoot, { fetch: serve('', 404) }), /Download failed \(404\)/)
    const withoutRg = tarball({ 'package.json': manifest, 'vendor/tree-sitter/index.js': '' })
    const withoutVendor = tarball({ 'package.json': manifest, 'bin/rg': 'rg' })
    const wrongVersion = tarball({ ...complete, 'package.json': manifest.replace(CURSOR_SDK_VERSION, '1.0.31') })
    for (const bytes of [withoutRg, withoutVendor, wrongVersion]) {
      await assert.rejects(installTarget(pinned(bytes), helperRoot, { fetch: serve(bytes) }), /Invalid SDK platform/)
    }
    // Failures leave the previous helper intact and no staging directories behind.
    assert.deepEqual(readdirSync(destination), ['previous'])
    assert.deepEqual(readdirSync(helperRoot).sort(), ['sdk', 'sdk-linux-x64'])

    const bytes = tarball(complete)
    assert.equal(await installTarget(pinned(bytes), helperRoot, { fetch: serve(bytes) }), destination)
    assert.equal(destination, path.join(repo, 'apps/desktop/node_modules/@cursor/sdk-linux-x64'))
    assert.deepEqual(readdirSync(destination).sort(), ['bin', 'package.json', 'vendor'])
    if (process.platform !== 'win32') assert.ok(statSync(path.join(destination, 'bin/rg')).mode & 0o111)
    assert.ok(
      requested.every(
        (url) => url === `https://registry.npmjs.org/@cursor/sdk-linux-x64/-/sdk-linux-x64-${CURSOR_SDK_VERSION}.tgz`
      )
    )
  }))

test('Windows ARM64 prunes every helper beside the workspace SDK without downloading', async () =>
  withRepo(async (repo) => {
    fakeSdk(repo, 'apps/desktop')
    const { helperRoot } = resolveCursorSdk(repo)
    for (const target of TARGETS) mkdirSync(path.join(helperRoot, `sdk-${target.npmSuffix}`))
    const download = () => assert.fail('Windows ARM64 has no helper to download')
    await main(['--target=win-arm64', '--prune'], { repoRoot: repo, fetch: download })
    assert.deepEqual(readdirSync(helperRoot), ['sdk'])
  }))
