#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'
import { CURSOR_SDK_VERSION, TARGETS } from './fetch-cursor-sdk-platform.mjs'
import {
  extractAppImage,
  extractDeb,
  extractNestedInstallerArchives,
  extractSevenZip,
  isPackagedArtifact,
  layoutsUnder,
  mountDmg,
} from './verify-packaged-sounds.mjs'

export function cursorSdkRgBinary(platform) {
  return platform === 'win' ? 'rg.exe' : 'rg'
}
/** `listPackage()` joins entries with the host separator, so Windows reports backslash paths. */
function posixEntries(entries) {
  return entries.map((entry) => entry.replaceAll('\\', '/'))
}
/** asar resolves lookups by splitting on `path.sep`, so archive paths need the host separator. */
export function archiveEntryPath(posixPath, separator = path.sep) {
  return posixPath.split('/').join(separator)
}
export function verifyPlatformEntries(entries, targetId) {
  const target = TARGETS.find((item) => item.id === targetId)
  if (!target && targetId !== 'win-arm64') throw new Error(`Unknown target: ${targetId}`)
  const actual = [
    ...new Set(
      posixEntries(entries)
        .filter((entry) => entry.startsWith('/node_modules/@cursor/sdk-'))
        .map((entry) => entry.split('/')[3])
    ),
  ]
  const expected = target ? [`sdk-${target.npmSuffix}`] : []
  if (actual.length !== expected.length || actual.some((name) => !expected.includes(name))) {
    throw new Error(`Unexpected or missing Cursor platform packages for ${targetId}: ${actual.join(', ')}`)
  }
  return target
}
export function verifyLayout(layout, targetId) {
  const archive = path.join(layout.resources, 'app.asar')
  const entries = posixEntries(listPackage(archive))
  const target = verifyPlatformEntries(entries, targetId)
  const sdk = JSON.parse(extractFile(archive, archiveEntryPath('node_modules/@cursor/sdk/package.json')))
  if (sdk.version !== CURSOR_SDK_VERSION) throw new Error('Incorrect packaged Cursor SDK version')
  if (!target) return
  const prefix = `node_modules/@cursor/sdk-${target.npmSuffix}`
  const pkg = JSON.parse(extractFile(archive, archiveEntryPath(`${prefix}/package.json`)))
  if (pkg.version !== CURSOR_SDK_VERSION) throw new Error('Incorrect packaged Cursor helper version')
  if (!entries.includes(`/${prefix}/vendor/tree-sitter/index.js`)) throw new Error('Missing Cursor tree-sitter vendor')
  const binary = path.join(layout.resources, 'app.asar.unpacked', prefix, 'bin', cursorSdkRgBinary(layout.platform))
  if (!existsSync(binary) || !statSync(binary).isFile())
    throw new Error(`Missing unpacked Cursor executable: ${binary}`)
  if (layout.platform !== 'win' && !(statSync(binary).mode & 0o111)) throw new Error('Cursor rg is not executable')
  console.log(`[cursor-sdk] Verified ${targetId} at ${layout.resources}`)
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}
export function main(argv = process.argv.slice(2)) {
  const input = path.resolve(argv.find((arg) => !arg.startsWith('--')) ?? 'apps/desktop/dist')
  const platform =
    argv.find((arg) => arg.startsWith('--platform='))?.split('=')[1] ??
    (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform)
  const arch = argv.find((arg) => arg.startsWith('--arch='))?.split('=')[1] ?? process.arch
  const targetId = `${platform}-${arch}`
  const layouts = layoutsUnder(input, platform, platform)
  for (const layout of layouts) verifyLayout(layout, targetId)
  const artifacts = argv.includes('--unpacked-only')
    ? []
    : walk(input).filter((file) => isPackagedArtifact(file, platform))
  for (const artifact of artifacts) {
    const temporary = mkdtempSync(path.join(tmpdir(), 'maestrly-cursor-verify-'))
    let unmount
    try {
      const lower = artifact.toLowerCase()
      if (lower.endsWith('.appimage')) extractAppImage(artifact, temporary)
      else if (lower.endsWith('.deb')) extractDeb(artifact, temporary)
      else if (lower.endsWith('.dmg')) unmount = mountDmg(artifact, temporary)
      else {
        extractSevenZip(artifact, temporary)
        if (lower.endsWith('.exe')) extractNestedInstallerArchives(temporary)
      }
      const extracted = layoutsUnder(temporary, platform, platform)
      if (extracted.length !== 1) throw new Error(`Expected one application in ${artifact}, found ${extracted.length}`)
      verifyLayout(extracted[0], targetId)
    } finally {
      unmount?.()
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  if (!layouts.length && !artifacts.length) throw new Error(`No packaged application found in ${input}`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
