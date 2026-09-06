import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { stageReleaseAssets } from '../../scripts/stage-release-assets.mjs'

async function createWorkspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'maestrly-release-assets-'))
  const sourceDir = path.join(root, 'dist')
  const outputDir = path.join(root, 'out')
  await mkdir(sourceDir)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { sourceDir, outputDir }
}

test('stages Linux artifacts with deterministic public names', async (t) => {
  const { sourceDir, outputDir } = await createWorkspace(t)
  await writeFile(path.join(sourceDir, 'Maestrly App-0.1.0.AppImage'), 'appimage')
  await writeFile(path.join(sourceDir, 'maestrly-app_0.1.0_amd64.deb'), 'deb')
  await writeFile(path.join(sourceDir, 'latest-linux.yml'), 'metadata')
  await writeFile(path.join(sourceDir, 'Maestrly App-0.1.0.AppImage.blockmap'), 'blockmap')
  await mkdir(path.join(sourceDir, 'linux-unpacked'))
  await writeFile(path.join(sourceDir, 'linux-unpacked', 'nested.deb'), 'nested')

  const staged = await stageReleaseAssets({ platform: 'linux', sourceDir, outputDir, version: '0.1.0' })

  assert.deepEqual(staged.map((file) => path.basename(file)), [
    'Maestrly-App-0.1.0-linux-x64.AppImage',
    'Maestrly-App-0.1.0-linux-x64.deb',
  ])
  assert.equal(await readFile(staged[0], 'utf8'), 'appimage')
  assert.equal(await readFile(staged[1], 'utf8'), 'deb')
})

test('stages Windows and macOS artifacts with deterministic public names', async (t) => {
  const windows = await createWorkspace(t)
  await writeFile(path.join(windows.sourceDir, 'Maestrly App Setup 1.2.3.exe'), 'windows')
  const windowsStaged = await stageReleaseAssets({
    platform: 'windows',
    sourceDir: windows.sourceDir,
    outputDir: windows.outputDir,
    version: '1.2.3',
  })
  assert.deepEqual(windowsStaged.map((file) => path.basename(file)), [
    'Maestrly-App-1.2.3-windows-x64.exe',
  ])

  const macos = await createWorkspace(t)
  await writeFile(path.join(macos.sourceDir, 'Maestrly App-2.0.0-arm64.dmg'), 'dmg')
  await writeFile(path.join(macos.sourceDir, 'Maestrly App-2.0.0-arm64-mac.zip'), 'zip')
  const macosStaged = await stageReleaseAssets({
    platform: 'macos',
    sourceDir: macos.sourceDir,
    outputDir: macos.outputDir,
    version: '2.0.0-beta.1',
  })
  assert.deepEqual(macosStaged.map((file) => path.basename(file)), [
    'Maestrly-App-2.0.0-beta.1-macos-arm64.dmg',
    'Maestrly-App-2.0.0-beta.1-macos-arm64.zip',
  ])
})

test('rejects unsupported platforms and invalid versions', async (t) => {
  const { sourceDir, outputDir } = await createWorkspace(t)
  await assert.rejects(
    stageReleaseAssets({ platform: 'freebsd', sourceDir, outputDir, version: '1.0.0' }),
    /Unsupported release platform: freebsd/
  )
  await assert.rejects(
    stageReleaseAssets({ platform: 'windows', sourceDir, outputDir, version: '01.0.0' }),
    /Invalid release version: 01\.0\.0/
  )
})

test('rejects missing, duplicate, and empty distributables', async (t) => {
  const missing = await createWorkspace(t)
  await writeFile(path.join(missing.sourceDir, 'app.AppImage'), 'appimage')
  await assert.rejects(
    stageReleaseAssets({ platform: 'linux', ...missing, version: '1.0.0' }),
    /Expected exactly one \.deb release artifact; found 0/
  )

  const duplicate = await createWorkspace(t)
  await writeFile(path.join(duplicate.sourceDir, 'first.exe'), 'first')
  await writeFile(path.join(duplicate.sourceDir, 'second.exe'), 'second')
  await assert.rejects(
    stageReleaseAssets({ platform: 'windows', ...duplicate, version: '1.0.0' }),
    /Expected exactly one \.exe release artifact; found 2/
  )

  const empty = await createWorkspace(t)
  await writeFile(path.join(empty.sourceDir, 'empty.exe'), '')
  await assert.rejects(
    stageReleaseAssets({ platform: 'windows', ...empty, version: '1.0.0' }),
    /Release artifact is empty: empty\.exe/
  )
})

test('rejects symbolic-link artifacts and non-empty output directories', async (t) => {
  const linked = await createWorkspace(t)
  const target = path.join(path.dirname(linked.sourceDir), 'installer.bin')
  await writeFile(target, 'installer')
  await symlink(target, path.join(linked.sourceDir, 'installer.exe'))
  await assert.rejects(
    stageReleaseAssets({ platform: 'windows', ...linked, version: '1.0.0' }),
    /Release artifact must be a regular file: installer\.exe/
  )

  const populated = await createWorkspace(t)
  await writeFile(path.join(populated.sourceDir, 'installer.exe'), 'installer')
  await mkdir(populated.outputDir)
  await writeFile(path.join(populated.outputDir, 'existing.txt'), 'existing')
  await assert.rejects(
    stageReleaseAssets({ platform: 'windows', ...populated, version: '1.0.0' }),
    /Release output directory must be empty/
  )
})
