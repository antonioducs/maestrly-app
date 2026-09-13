import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPackage, sha256 } from '../../../deploy/host/macos/verify-package.mjs'
import { transfer } from '../../../scripts/host-lab.mjs'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'host-package-'))
  const directory = join(root, 'package'),
    reports = join(root, 'reports')
  await mkdir(directory)
  await mkdir(reports)
  await writeFile(join(directory, 'payload'), 'pinned package')
  const manifestPath = join(directory, 'manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify({ version: 1, files: [{ path: 'payload', sha256: await sha256(join(directory, 'payload')) }] })
  )
  return { root, directory, reports, manifestPath, digest: await sha256(manifestPath) }
}
test('verifies complete hashes; rejects tampered and unlisted package content', async () => {
  const f = await fixture()
  try {
    await verifyPackage(f.directory, f.manifestPath, f.digest)
    await assert.rejects(verifyPackage(f.directory, f.manifestPath, '0'.repeat(64)), /checksum/)
    await writeFile(join(f.directory, 'extra'), 'unlisted')
    await assert.rejects(verifyPackage(f.directory, f.manifestPath, f.digest), /inventory/)
    await rm(join(f.directory, 'extra'))
    await writeFile(join(f.directory, 'payload'), 'tampered')
    await assert.rejects(verifyPackage(f.directory, f.manifestPath, f.digest), /checksum/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('transfer streams a verified package to fixed exclusive staging, with intent before SSH', { skip: process.platform === 'win32' && 'Requires POSIX tar and directory fsync' }, async () => {
  const f = await fixture()
  try {
    let transferred = 0
    const result = await transfer(
      { packageDirectory: f.directory, manifestPath: f.manifestPath, manifestSha256: f.digest },
      f.reports,
      async (_config, command, input) => {
        assert.match(command, /mkdir \/private\/var\/tmp\/maestrly-host-package &&/)
        assert.doesNotMatch(command, /mkdir -p|sudo|rm /)
        assert.equal(
          JSON.parse(await readFile(join(f.reports, 'transfer-intent.json'), 'utf8')).manifestSha256,
          f.digest
        )
        for await (const bytes of input) transferred += bytes.length
        return { code: 0, stdout: '' }
      }
    )
    assert(transferred > 0)
    assert.equal(result.transferred, true)
    assert.equal(result.status, 'needs_action')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
test('installer executes the complete manifest verifier before any installation reservation', async () => {
  const { spawnSync } = await import('node:child_process')
  const f = await fixture()
  try {
    const installer = await readFile(new URL('../../../deploy/host/macos/install.sh', import.meta.url), 'utf8')
    const verifier = installer.split("<<'VERIFY_PACKAGE'\n")[1].split('\nVERIFY_PACKAGE')[0]
    assert(installer.indexOf("<<'VERIFY_PACKAGE'") < installer.indexOf('mkdir -m 755 "$base"'))
    const run = () =>
      spawnSync(process.execPath, ['--input-type=module', '-', f.directory, f.digest], {
        input: verifier,
        encoding: 'utf8',
      })
    assert.equal(run().status, 0)
    await writeFile(join(f.directory, 'payload'), 'tampered')
    assert.notEqual(run().status, 0)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('rejects linked package content when symlinks are supported', async (t) => {
  const f = await fixture()
  try {
    await rm(join(f.directory, 'payload'))
    try {
      await symlink(f.manifestPath, join(f.directory, 'payload'), 'file')
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code))
        return t.skip('Windows symlink capability is unavailable')
      throw error
    }
    await assert.rejects(verifyPackage(f.directory, f.manifestPath, f.digest), /Unsafe/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
