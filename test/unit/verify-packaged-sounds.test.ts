import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
// Executable ESM script without declarations; imported only to test layout discovery.
// @ts-expect-error
import * as verifySounds from '../../scripts/verify-packaged-sounds.mjs'

const { isPackagedArtifact, layoutsUnder, prepareSevenZipExecutable, resolveSevenZipExecutable } = verifySounds

const tempDirs: string[] = []
const script = fileURLToPath(new URL('../../scripts/verify-packaged-sounds.mjs', import.meta.url))

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestrly-sounds-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('verify-packaged-sounds layout discovery', () => {
  it('classifies NSIS-extracted app.asar using the known artifact platform', () => {
    const root = makeTempDir()
    const resources = join(root, '$PLUGINSDIR', 'app-64.7z.extracted', 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'app.asar'), '')

    expect(layoutsUnder(root, 'win', 'win')).toEqual([
      {
        platform: 'win',
        resources,
        asar: join(resources, 'app.asar'),
      },
    ])
  })

  it('does not extract the internal win-unpacked executable as an NSIS installer', () => {
    expect(isPackagedArtifact('/dist/Maestrly Setup 1.0.0.exe', 'win')).toBe(true)
    expect(isPackagedArtifact('/dist/win-unpacked/Maestrly.exe', 'win')).toBe(false)
    expect(isPackagedArtifact('C:\\dist\\Win-Unpacked\\Maestrly.exe', 'win')).toBe(false)
  })

  it('fails when the required final artifact format was not generated', () => {
    const root = makeTempDir()
    const result = spawnSync(process.execPath, [script, root, '--platform=win', '--require-artifact=exe'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('required artifact .exe missing')
  })

  it.runIf(process.platform !== 'win32')('restores the bundled archive helper executable bit', () => {
    const binary = join(makeTempDir(), '7za')
    writeFileSync(binary, 'synthetic binary')
    chmodSync(binary, 0o644)

    expect(prepareSevenZipExecutable(binary, process.platform)).toBe(binary)
    expect(statSync(binary).mode & 0o111).not.toBe(0)
  })

  it('prefers a modern system 7-Zip installation on Windows and retains the bundled fallback', () => {
    const programFiles = join(makeTempDir(), 'Program Files')
    const systemBinary = join(programFiles, '7-Zip', '7z.exe')
    const bundledBinary = join(makeTempDir(), '7za.exe')
    mkdirSync(join(programFiles, '7-Zip'), { recursive: true })
    writeFileSync(systemBinary, 'system')
    writeFileSync(bundledBinary, 'bundled')

    expect(
      resolveSevenZipExecutable({
        bundled: bundledBinary,
        platform: 'win32',
        environment: { ProgramFiles: programFiles },
      }),
    ).toBe(systemBinary)
    expect(
      resolveSevenZipExecutable({ bundled: bundledBinary, platform: 'win32', environment: {} }),
    ).toBe(bundledBinary)
  })

  // 7zip-bin cannot open DMG; mount it with hdiutil on macOS.
  it.runIf(process.platform === 'darwin')(
    'verifies a real DMG through hdiutil attach and detach',
    async () => {
      const root = makeTempDir()
      const appResources = join(root, 'src', 'Maestrly.app', 'Contents', 'Resources')
      mkdirSync(appResources, { recursive: true })
      cpSync(join(process.cwd(), 'resources', 'sounds'), join(appResources, 'sounds'), { recursive: true })
      const asarSrc = join(root, 'asar-src')
      mkdirSync(asarSrc, { recursive: true })
      writeFileSync(join(asarSrc, 'package.json'), '{"name":"fixture"}')
      await createPackage(asarSrc, join(appResources, 'app.asar'))

      const dist = join(root, 'dist')
      mkdirSync(dist)
      const dmg = join(dist, 'Maestrly-0.0.1-arm64.dmg')
      const create = spawnSync(
        'hdiutil',
        ['create', '-srcfolder', join(root, 'src'), '-volname', 'Maestrly', '-fs', 'HFS+', '-format', 'UDZO', '-quiet', dmg],
        { encoding: 'utf8' },
      )
      expect(create.status).toBe(0)

      const result = spawnSync(process.execPath, [script, dist, '--platform=mac', '--require-artifact=dmg'], {
        encoding: 'utf8',
      })
      expect(result.stderr).toContain('ok: Maestrly-0.0.1-arm64.dmg')
      expect(result.status).toBe(0)
      // Detach must remove the temporary mountpoint from hdiutil info.
      const info = spawnSync('hdiutil', ['info'], { encoding: 'utf8' })
      expect(info.stdout).not.toContain('maestrly-sounds-')
    },
    30_000,
  )
})
