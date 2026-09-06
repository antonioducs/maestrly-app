#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const require = createRequire(import.meta.url)
const sevenZip = require('7zip-bin').path7za

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const expected = {
  'glass_001.wav': '39182b395a30b34e18cbcf842922552b23da5b010a52b7777557e02a405f083e',
  'bong_001.wav': 'f5d5f83b13edc5321352c2ba57972d1400151e3f27f1c18fcda07d261358511a',
  'confirmation_001.wav': 'f9d0ef5a5c740c2ac250ac3876db9e4340669044a5bf78ae09192918db3e2ebc',
  'pluck_001.wav': '7d676b0b09b56f7e5964ad274feb7e7307a4e552bed8cd98e1e3cecfb9c10c36',
  'maximize_001.wav': 'c49992256551200a65d77cbdaf9cb691c8a698aaca0a37b56d6be03fef58aa77',
  'glitch_001.wav': '2ea6b5166dc9295cda99d2845bffb030a00e48cfb8d3c52addd4adb5df6217d0',
  'error_001.wav': 'd77546b0baa89f37eca6b86f59b54a654ce5afe3d5a73492d0963168cc4ab5bf',
  'tick_001.wav': 'fee217e21731da4be1f0347fd2632296259b8bfdca343c936fe60dc64bce280e',
}
const requiredMetadata = ['LICENSE.txt', 'README.md']

function fail(message) {
  console.error(`[verify-sounds] ERROR: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  let input = path.join(root, 'dist')
  let platform = null
  let unpackedOnly = false
  const requiredArtifacts = []
  for (const arg of argv) {
    if (arg === '--unpacked-only') unpackedOnly = true
    else if (arg.startsWith('--platform=')) platform = arg.slice('--platform='.length)
    else if (arg.startsWith('--require-artifact='))
      requiredArtifacts.push(arg.slice('--require-artifact='.length).toLowerCase())
    else if (arg.startsWith('--')) fail(`unknown flag: ${arg}`)
    else input = path.resolve(root, arg)
  }
  if (platform && !['mac', 'win', 'linux'].includes(platform)) fail(`invalid platform: ${platform}`)
  const validArtifacts = new Set(['appimage', 'deb', 'dmg', 'exe', 'zip'])
  const invalidArtifact = requiredArtifacts.find((format) => !validArtifacts.has(format))
  if (invalidArtifact) fail(`invalid artifact format: ${invalidArtifact}`)
  return { input, platform, unpackedOnly, requiredArtifacts }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function walk(dir, maxDepth, visit, depth = 0) {
  if (!existsSync(dir) || depth > maxDepth) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    visit(full, entry)
    if (entry.isDirectory()) walk(full, maxDepth, visit, depth + 1)
  }
}

export function layoutsUnder(dir, platform, artifactPlatform = null) {
  const layouts = []
  walk(dir, 10, (full, entry) => {
    if (!entry.isFile() || entry.name !== 'app.asar') return
    const normalized = full.replaceAll('\\', '/')
    const inferred =
      artifactPlatform ??
      (normalized.includes('.app/Contents/Resources/')
        ? 'mac'
        : normalized.includes('/win-unpacked/')
          ? 'win'
          : 'linux')
    if (!platform || platform === inferred)
      layouts.push({ platform: inferred, resources: path.dirname(full), asar: full })
  })
  return layouts
}

function verifyLayout(layout, label) {
  const sounds = path.join(layout.resources, 'sounds')
  if (!existsSync(sounds) || !statSync(sounds).isDirectory()) fail(`${label}: missing directory: ${sounds}`)
  for (const [name, expectedHash] of Object.entries(expected)) {
    const file = path.join(sounds, name)
    if (!existsSync(file)) fail(`${label}: asset missing: ${name}`)
    const actual = sha256(file)
    if (actual !== expectedHash) fail(`${label}: hash mismatch in ${name}: ${actual}`)
  }
  for (const name of requiredMetadata) {
    if (!existsSync(path.join(sounds, name))) fail(`${label}: metadata missing: ${name}`)
  }
  const wavFiles = readdirSync(sounds)
    .filter((name) => name.endsWith('.wav'))
    .sort()
  if (wavFiles.length !== Object.keys(expected).length) {
    fail(`${label}: expected 8 WAVs, found ${wavFiles.length}: ${wavFiles.join(', ')}`)
  }
  let asarEntries
  try {
    asarEntries = listPackage(layout.asar, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'))
  } catch (error) {
    fail(`${label}: could not inspect ${layout.asar}: ${error instanceof Error ? error.message : error}`)
  }
  if (asarEntries.some((entry) => /(^|\/)resources\/sounds(\/|$)/.test(entry))) {
    fail(`${label}: resources/sounds was duplicated inside app.asar`)
  }
  console.error(`[verify-sounds] ok: ${label} (${sounds})`)
}

function appImageSquashfsOffset(file) {
  const fd = openSync(file, 'r')
  try {
    const header = Buffer.alloc(64)
    readSync(fd, header, 0, 64, 0)
    if (header.readUInt32BE(0) !== 0x7f454c46) fail(`${path.basename(file)}: is not an ELF`)
    const is64 = header[4] === 2
    const offset = is64
      ? Number(header.readBigUInt64LE(0x28)) + header.readUInt16LE(0x3a) * header.readUInt16LE(0x3c)
      : header.readUInt32LE(0x20) + header.readUInt16LE(0x2e) * header.readUInt16LE(0x30)
    const magic = Buffer.alloc(4)
    readSync(fd, magic, 0, 4, offset)
    if (magic.toString('latin1') !== 'hsqs') {
      fail(`${path.basename(file)}: squashfs not found at offset ${offset} (magic ${magic.toString('hex')})`)
    }
    return offset
  } finally {
    closeSync(fd)
  }
}

export function extractAppImage(file, out) {
  const result = spawnSync(file, ['--appimage-extract'], {
    cwd: out,
    encoding: 'utf8',
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
  })
  if (!result.error && result.status === 0) return

  const offset = appImageSquashfsOffset(file)
  const unsquash = spawnSync('unsquashfs', ['-offset', String(offset), '-d', path.join(out, 'squashfs-root'), file], {
    encoding: 'utf8',
  })
  if (unsquash.error || unsquash.status !== 0) {
    const detail = unsquash.error?.message ?? unsquash.stderr?.trim() ?? unsquash.status
    fail(
      `${path.basename(file)}: AppImage extraction failed (direct execution: ${result.error?.message ?? result.stderr?.trim() ?? result.status}; unsquashfs: ${detail}). Install squashfs-tools in the build environment.`
    )
  }
}

export function extractDeb(file, out) {
  const result = spawnSync('dpkg-deb', ['-x', file, out], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    fail(
      `${path.basename(file)}: dpkg-deb -x failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`
    )
  }
}

export function prepareSevenZipExecutable(binary = sevenZip, platform = process.platform) {
  if (platform !== 'win32') chmodSync(binary, 0o755)
  return binary
}

export function resolveSevenZipExecutable({
  bundled = sevenZip,
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform === 'win32') {
    // 7zip-bin uses an older standalone extractor that cannot decode newer NSIS ARM64 BCJ filters.
    // Prefer the current system installation on Windows runners, then retain the bundled fallback.
    const roots = [...new Set([environment.ProgramW6432, environment.ProgramFiles].filter(Boolean))]
    for (const root of roots) {
      const candidate = path.join(root, '7-Zip', '7z.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return prepareSevenZipExecutable(bundled, platform)
}

export function extractSevenZip(file, out) {
  const binary = resolveSevenZipExecutable()
  const result = spawnSync(binary, ['x', '-y', `-o${out}`, file], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    fail(
      `${path.basename(file)}: 7-Zip extraction failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`
    )
  }
}

const pendingMounts = new Set()
process.on('exit', () => {
  for (const mountpoint of pendingMounts) {
    spawnSync('hdiutil', ['detach', mountpoint, '-force'], { encoding: 'utf8' })
  }
})

export function mountDmg(file, mountpoint) {
  const result = spawnSync(
    'hdiutil',
    ['attach', '-nobrowse', '-noautoopen', '-noverify', '-readonly', '-mountpoint', mountpoint, file],
    { encoding: 'utf8' }
  )
  if (result.error || result.status !== 0) {
    fail(
      `${path.basename(file)}: hdiutil attach failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`
    )
  }
  pendingMounts.add(mountpoint)
  return () => {
    const detach = spawnSync('hdiutil', ['detach', mountpoint, '-quiet'], { encoding: 'utf8' })
    if (detach.error || detach.status !== 0)
      spawnSync('hdiutil', ['detach', mountpoint, '-force'], { encoding: 'utf8' })
    pendingMounts.delete(mountpoint)
  }
}

export function extractNestedInstallerArchives(rootDir) {
  const nested = []
  walk(rootDir, 8, (full, entry) => {
    if (entry.isFile() && full.toLowerCase().endsWith('.7z')) nested.push(full)
  })
  for (const archive of nested) extractSevenZip(archive, `${archive}.extracted`)
}

export function isPackagedArtifact(file, platform) {
  const normalized = file.replaceAll('\\', '/')
  if (normalized.split('/').some((segment) => segment.toLowerCase().endsWith('-unpacked'))) return false
  const lower = normalized.toLowerCase()
  const linux = (!platform || platform === 'linux') && (lower.endsWith('.appimage') || lower.endsWith('.deb'))
  const mac = (!platform || platform === 'mac') && (lower.endsWith('.zip') || lower.endsWith('.dmg'))
  const win = (!platform || platform === 'win') && lower.endsWith('.exe')
  return linux || mac || win
}

export function main(argv = process.argv.slice(2)) {
  const { input, platform, unpackedOnly, requiredArtifacts } = parseArgs(argv)
  if (!existsSync(input)) fail(`output not found: ${input}`)

  let verified = 0
  const directLayouts = layoutsUnder(input, platform)
  for (const layout of directLayouts) {
    verifyLayout(layout, `${layout.platform} unpacked`)
    verified += 1
  }

  if (!unpackedOnly) {
    const artifacts = []
    walk(input, 4, (full, entry) => {
      if (entry.isFile() && isPackagedArtifact(full, platform)) artifacts.push(full)
    })
    for (const format of requiredArtifacts) {
      if (!artifacts.some((artifact) => artifact.toLowerCase().endsWith(`.${format}`))) {
        fail(`required artifact .${format} missing in ${input}`)
      }
    }

    for (const artifact of artifacts) {
      const temp = mkdtempSync(path.join(tmpdir(), 'maestrly-sounds-'))
      let unmount = null
      try {
        const lower = artifact.toLowerCase()
        if (lower.endsWith('.appimage')) extractAppImage(artifact, temp)
        else if (lower.endsWith('.deb')) extractDeb(artifact, temp)
        else if (lower.endsWith('.dmg')) unmount = mountDmg(artifact, temp)
        else {
          extractSevenZip(artifact, temp)
          if (lower.endsWith('.exe')) extractNestedInstallerArchives(temp)
        }
        const artifactPlatform = lower.endsWith('.exe')
          ? 'win'
          : lower.endsWith('.appimage') || lower.endsWith('.deb')
            ? 'linux'
            : 'mac'
        const extracted = layoutsUnder(temp, artifactPlatform, artifactPlatform)
        if (extracted.length !== 1) {
          fail(`${path.basename(artifact)}: expected 1 extracted app.asar, found ${extracted.length}`)
        }
        verifyLayout(extracted[0], path.basename(artifact))
        verified += 1
      } finally {
        unmount?.()
        rmSync(temp, { recursive: true, force: true })
      }
    }
  }

  if (verified === 0) fail(`no compatible packaged layout found in ${input}`)
  console.error(`[verify-sounds] ${verified} layout(s)/artifact(s) verified; assets are outside ASAR and intact.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
