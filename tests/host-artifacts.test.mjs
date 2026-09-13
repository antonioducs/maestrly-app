import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { safeRelative, verifyInput, validateBuildConfig } from '../scripts/host-build-utils.mjs'

test('artifact paths reject traversal, absolute paths and option syntax', () => {
  for (const value of ['../bin', '/bin/node', 'bin/../../x', '-x', 'a\\b', 'a,b', ''])
    assert.throws(() => safeRelative(value))
  assert.equal(safeRelative('bin/qemu-system-aarch64'), 'bin/qemu-system-aarch64')
})
test('verification refuses modified build inputs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'host-artifact-'))
  try {
    await writeFile(path.join(dir, 'node'), 'verified')
    const digest = createHash('sha256').update('verified').digest('hex')
    await verifyInput(dir, { path: 'node', sha256: digest })
    await assert.rejects(verifyInput(dir, { path: 'node', sha256: '0'.repeat(64) }), /HASH/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('build does not infer architecture or allow unpinned artifacts', () => {
  assert.throws(() => validateBuildConfig({}), /CONFIG/)
  assert.throws(() => validateBuildConfig({ architecture: 'arm64', nodeVersion: 'latest', files: [] }), /CONFIG/)
})

test('build accepts a complete pinned x64 manifest and rejects duplicate inputs', () => {
  const config = {
    architecture: 'x64',
    nodeVersion: '22.23.2',
    qemuVersion: '10.2.0',
    inputDirectory: path.resolve('build/runtime'),
    files: ['bin/node', 'bin/qemu-img', 'bin/qemu-system-x86_64'].map((path) => ({
      path,
      sha256: 'a'.repeat(64),
      license: 'See supplied notices',
      source: 'https://example.org/pinned',
    })),
  }
  assert.equal(validateBuildConfig(config), config)
  assert.throws(() => validateBuildConfig({ ...config, files: [...config.files, config.files[0]] }), /CONFIG/)
})

test('QEMU image preparation pins QGA, disables logins and cleans instance identity', async () => {
  const { imageBuildUserData } = await import('../scripts/build-host-image-qemu.mjs')
  const id = '11111111-1111-4111-8111-111111111111'
  assert.throws(() => imageBuildUserData({ guestAgentVersion: "1'; touch /x" }, id), /IMAGE_PACKAGES/)
  const text = imageBuildUserData({ guestAgentVersion: '1:8.2.2+ds-0ubuntu1.13' }, id)
  assert.match(text, /ssh_pwauth: false/)
  assert.match(text, /users: \[\]/)
  assert.match(text, /qemu-guest-agent, '1:8.2.2\+ds-0ubuntu1.13'/)
  assert.match(text, /clean --logs --machine-id --seed/)
  assert.match(text, /MAESTRLY_IMAGE_BUILT:/)
  assert.match(text, /mask systemd-networkd-wait-online.service/)
})

test('Mach-O minimum OS is measured from modern or legacy load commands', async () => {
  const { minimumMacOS, compareVersions } = await import('../scripts/host-build-utils.mjs')
  assert.equal(minimumMacOS('cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 1\nminos 26.0\nsdk 26.5'), '26.0')
  assert.equal(minimumMacOS('cmd LC_VERSION_MIN_MACOSX\ncmdsize 16\nversion 11.0\nsdk 14.0'), '11.0')
  assert.throws(() => minimumMacOS('no commands'), /MACHO/)
  assert.ok(compareVersions('26.0', '15.6') > 0)
})

test('installation refuses architecture translation and artifacts newer than macOS', async () => {
  const { assertPackageCompatibility } = await import('../deploy/host/macos/check-compatibility.mjs')
  const manifest = { architecture: 'arm64', minimumMacOS: '26.0', nodeVersion: '22.23.2' }
  const host = { platform: 'darwin', arch: 'arm64', physicalArch: 'arm64', macOS: '26.6.2', nodeVersion: '22.23.2' }
  assert.doesNotThrow(() => assertPackageCompatibility(manifest, host))
  assert.throws(() => assertPackageCompatibility(manifest, { ...host, macOS: '15.6' }), /PACKAGE_MACOS/)
  assert.throws(() => assertPackageCompatibility(manifest, { ...host, arch: 'x64' }), /PACKAGE_ARCHITECTURE/)
  assert.throws(() => assertPackageCompatibility(manifest, { ...host, platform: 'linux' }), /PACKAGE_PLATFORM/)
})

test('verification refuses symlinked build inputs when symlinks are available', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'host-symlink-'))
  try {
    await writeFile(path.join(dir, 'node'), 'verified')
    const digest = createHash('sha256').update('verified').digest('hex')
    try {
      await symlink(path.join(dir, 'node'), path.join(dir, 'alias'))
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Symlink capability unavailable')
        return
      }
      throw error
    }
    await assert.rejects(verifyInput(dir, { path: 'alias', sha256: digest }), /SYMLINK/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('browser boundary detects bare Node builtins as well as node-prefixed imports', async () => {
  const {usesNode} = await import('../scripts/check-boundaries.mjs')
  for (const code of ["import fs from 'fs'", "import 'node:fs'", "const fs = require('fs/promises')", "await import('node:child_process')"]) assert.equal(usesNode(code), true)
  assert.equal(usesNode("import {z} from 'zod'"), false)
})
