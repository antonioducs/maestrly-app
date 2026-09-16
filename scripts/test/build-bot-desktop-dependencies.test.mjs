import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DESKTOP_PACKAGES, mergeAddon, verifyDesktopPackages } from '../build-bot-desktop-dependencies.mjs'

const metadata = (entries) => `${entries.map(([name, version, arch = 'arm64']) => `Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}`).join('\n')}\n`
const pinned = Object.entries(DESKTOP_PACKAGES)

test('only the exact pinned screen-server closure may be downloaded', () => {
  assert.equal(verifyDesktopPackages(metadata(pinned)).size, 3)
  assert.throws(() => verifyDesktopPackages(metadata(pinned.slice(1))), /missing/)
  assert.throws(() => verifyDesktopPackages(metadata([...pinned, ['libc6', '2.39-0ubuntu8.9']])), /Unexpected/)
  assert.throws(() => verifyDesktopPackages(metadata([['tigervnc-common', '1.13.1+dfsg-2build3'], pinned[0], pinned[2]])), /Unexpected/)
  assert.throws(() => verifyDesktopPackages(metadata(pinned.map(([name, version]) => [name, version, 'amd64']))), /Unexpected/)
  assert.throws(() => verifyDesktopPackages(''), /Invalid/)
})

test('merging preserves the base addon, adds the pins and regenerates every checksum', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdd-'))
  const base = path.join(dir, 'base')
  await mkdir(path.join(base, 'debs'), { recursive: true })
  await writeFile(path.join(base, 'debs/xdotool_1_arm64.deb'), 'x')
  await writeFile(path.join(base, 'expected.tsv'), 'xdotool\t1\n')
  await writeFile(path.join(base, 'SHA256SUMS'), 'stale  debs/xdotool_1_arm64.deb\n')
  await writeFile(path.join(base, 'packages.txt'), 'Package: xdotool\nVersion: 1\nArchitecture: arm64\n')
  const debs = path.join(dir, 'new')
  await mkdir(debs)
  await writeFile(path.join(debs, 'tigervnc-common_1.13.1+dfsg-2build2_arm64.deb'), 'v')
  const pins = { 'tigervnc-common': '1.13.1+dfsg-2build2' }
  const text = metadata([['tigervnc-common', '1.13.1+dfsg-2build2']])
  const out = path.join(dir, 'out')
  await mergeAddon(base, debs, text, out, pins)
  assert.equal(await readFile(path.join(out, 'expected.tsv'), 'utf8'), 'tigervnc-common\t1.13.1+dfsg-2build2\nxdotool\t1\n')
  const sums = await readFile(path.join(out, 'SHA256SUMS'), 'utf8')
  assert.match(sums, /^[a-f0-9]{64} {2}debs\/tigervnc-common_1\.13\.1\+dfsg-2build2_arm64\.deb$/m)
  assert.match(sums, /^[a-f0-9]{64} {2}debs\/xdotool_1_arm64\.deb$/m)
  assert.doesNotMatch(sums, /stale/)
  assert.match(await readFile(path.join(out, 'packages.txt'), 'utf8'), /Package: xdotool[\s\S]+Package: tigervnc-common/)
  // The base is never modified and an existing output is never overwritten.
  assert.equal(await readFile(path.join(base, 'expected.tsv'), 'utf8'), 'xdotool\t1\n')
  await assert.rejects(mergeAddon(base, debs, text, out, pins))
  await assert.rejects(mergeAddon(base, debs, text, path.join(dir, 'conflict'), { xdotool: '2' }), /Conflicting pin/)
})
