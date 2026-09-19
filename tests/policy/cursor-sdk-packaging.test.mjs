import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  extractPackage,
  parseArgs,
  platformPackageSuffixesToPrune,
  TARGETS,
  verifyIntegrity,
} from '../../scripts/fetch-cursor-sdk-platform.mjs'
import { verifyPlatformEntries } from '../../scripts/verify-packaged-cursor-sdk.mjs'

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
})

test('platform suffixes match SDK optional dependencies and preserve upstream license', () => {
  const sdk = JSON.parse(readFileSync(new URL('../../node_modules/@cursor/sdk/package.json', import.meta.url), 'utf8'))
  for (const target of TARGETS) assert.equal(sdk.optionalDependencies[`@cursor/sdk-${target.npmSuffix}`], '1.0.31')
  assert.equal(
    readFileSync(new URL('../../apps/desktop/resources/licenses/cursor-sdk-LICENSE.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../../node_modules/@cursor/sdk/LICENSE.md', import.meta.url), 'utf8')
  )
})
