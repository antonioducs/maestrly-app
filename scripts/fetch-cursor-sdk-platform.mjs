#!/usr/bin/env node
// Materialize verified optional SDK helpers for one packaging target.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
export const CURSOR_SDK_VERSION = '1.0.34'
// npm dist.integrity, checked against downloaded bytes 2026-09-30. Upgrades require deliberate repinning.
export const TARGETS = [
  {
    id: 'mac-arm64',
    npmSuffix: 'darwin-arm64',
    integrity: 'sha512-V8ocCa606x3It1Be/2qSOxL3iXow9dgNiOX71cQORAQt7c8i6g+/hFw4KpOz/cUn4RZ8zv1S87ZyLy+c+AJ9eQ==',
  },
  {
    id: 'mac-x64',
    npmSuffix: 'darwin-x64',
    integrity: 'sha512-luq4CjDveDFoIo5pcP9Vrwp+yCMM4sMr2AVO7UqHpDskKUaQEX6iHOHjqYP6jkUMzFbf1fXkEYyBJlhKCGmdxg==',
  },
  {
    id: 'linux-arm64',
    npmSuffix: 'linux-arm64',
    integrity: 'sha512-o0/EOyl5WadSqg7oFx7bfsnYh6XLaw3g6BeNqYav2Al85Qzk/AgLZHbjs1unBPBpQos54+goEbgrfZuST1mzyA==',
  },
  {
    id: 'linux-x64',
    npmSuffix: 'linux-x64',
    integrity: 'sha512-5i2g8OCSnjiTQfhwV42y5Xpa4sAzwWEIs+oO47iG4QUXWuymrjnjZcQynAtsNkpZ7bzBaYT/0/geW08IJ7zuLg==',
  },
  {
    id: 'win-x64',
    npmSuffix: 'win32-x64',
    integrity: 'sha512-yn3V3ueSqbQWj+uaJp/lRFHaVmMgpJqQdI4MLv416Jgm5kfffrVTo7/ffjFu/CGhVUTvkPaifMXvI+zFhx3oOw==',
  },
]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
const hostId = `${hostOs}-${process.arch}`
function fail(message) {
  throw new Error(message)
}
function* tarEntries(buffer) {
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    const name = header
      .subarray(0, 100)
      .toString('utf8')
      .replace(/\0[\s\S]*$/, '')
    if (!name) break
    const prefix = header
      .subarray(345, 500)
      .toString('utf8')
      .replace(/\0[\s\S]*$/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').trim() || '0', 8)
    const mode = Number.parseInt(header.subarray(100, 108).toString('utf8').trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) fail(`Invalid tar entry: ${prefix ? `${prefix}/` : ''}${name}`)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) fail(`Truncated tarball at ${prefix ? `${prefix}/` : ''}${name}`)
    yield {
      name: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(header[156]),
      mode,
      data: buffer.subarray(dataStart, dataEnd),
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
}

function safeRelativePath(raw) {
  const parts = raw.replace(/\/$/, '').split('/')
  if (
    parts.length === 0 ||
    parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes(':'))
  ) {
    fail(`Unsafe tar path: ${raw}`)
  }
  return parts
}

export function extractPackage(tarball, temporary) {
  const prefix = 'package/'
  const archive = gunzipSync(tarball)
  let files = 0

  for (const entry of tarEntries(archive)) {
    if (!entry.name.startsWith(prefix)) continue
    const relative = entry.name.slice(prefix.length)
    if (!relative) continue
    const output = path.join(temporary, ...safeRelativePath(relative))

    if (entry.type === '5') {
      mkdirSync(output, { recursive: true })
      continue
    }
    if (entry.type !== '0' && entry.type !== '\0') {
      fail(`Unsupported tar type (${JSON.stringify(entry.type)}) at ${entry.name}`)
    }

    mkdirSync(path.dirname(output), { recursive: true })
    writeFileSync(output, entry.data)
    if ((entry.mode & 0o111) !== 0) chmodSync(output, entry.mode & 0o777)
    files++
  }

  if (files === 0) fail('Tarball contains no package files')
}

export function verifyIntegrity(tarball, integrity) {
  const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  if (actual !== integrity) fail('Cursor SDK tarball integrity mismatch')
}
export function parseArgs(argv) {
  let id = hostId
  let prune = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prune') prune = true
    else if (argv[i] === '--force') {
      /* Always verify the downloaded archive. */
    } else if (argv[i] === '--target') id = argv[++i]
    else if (argv[i].startsWith('--target=')) id = argv[i].slice(9)
    else fail(`Unknown flag: ${argv[i]}`)
  }
  const target = TARGETS.find((item) => item.id === id)
  if (!target && id !== 'win-arm64') fail(`Unsupported target: ${id}`)
  return { targets: target ? [target] : [], prune }
}
export function platformPackageSuffixesToPrune(targets) {
  const keep = new Set(targets.map((target) => target.npmSuffix))
  return TARGETS.filter((target) => !keep.has(target.npmSuffix)).map((target) => target.npmSuffix)
}
/**
 * Resolve `@cursor/sdk` as the desktop workspace does: apps/desktop/node_modules
 * first, then each parent up to the checkout root, so both npm layouts work.
 */
export function resolveCursorSdk(repoRoot = root) {
  const searched = []
  for (let dir = path.join(repoRoot, 'apps', 'desktop'); ; dir = path.dirname(dir)) {
    const directory = path.join(dir, 'node_modules', '@cursor', 'sdk')
    searched.push(directory)
    const manifest = path.join(directory, 'package.json')
    if (existsSync(manifest)) {
      const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
      if (version !== CURSOR_SDK_VERSION) {
        fail(`Expected @cursor/sdk ${CURSOR_SDK_VERSION}, found ${version} at ${directory}`)
      }
      // The SDK locates helpers as node_modules/@cursor/sdk-<platform>, beside itself.
      return { directory, helperRoot: path.dirname(directory) }
    }
    if (path.resolve(dir) === path.resolve(repoRoot) || path.dirname(dir) === dir) break
  }
  fail(`@cursor/sdk is not installed for apps/desktop; searched ${searched.join(', ')}`)
}
export function helperBinary(target) {
  return target.npmSuffix.startsWith('win32-') ? 'rg.exe' : 'rg'
}
/** Download, verify, and atomically replace one helper beside the resolved SDK. */
export async function installTarget(target, helperRoot, { fetch: download = globalThis.fetch } = {}) {
  const destination = path.join(helperRoot, `sdk-${target.npmSuffix}`)
  const temporary = `${destination}.tmp-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  try {
    const url = `https://registry.npmjs.org/@cursor/sdk-${target.npmSuffix}/-/sdk-${target.npmSuffix}-${CURSOR_SDK_VERSION}.tgz`
    const response = await download(url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) fail(`Download failed (${response.status}): ${url}`)
    const tarball = Buffer.from(await response.arrayBuffer())
    verifyIntegrity(tarball, target.integrity)
    extractPackage(tarball, temporary)
    const manifest = path.join(temporary, 'package.json')
    const pkg = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {}
    if (
      pkg.name !== `@cursor/sdk-${target.npmSuffix}` ||
      pkg.version !== CURSOR_SDK_VERSION ||
      !existsSync(path.join(temporary, 'bin', helperBinary(target))) ||
      !existsSync(path.join(temporary, 'vendor/tree-sitter/index.js'))
    )
      fail('Invalid SDK platform package')
    rmSync(destination, { recursive: true, force: true })
    renameSync(temporary, destination)
    console.log(`[cursor-sdk] Verified ${target.id}@${CURSOR_SDK_VERSION} at ${destination}`)
    return destination
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
export async function main(argv = process.argv.slice(2), { repoRoot = root, fetch: download = globalThis.fetch } = {}) {
  const options = parseArgs(argv)
  const { helperRoot } = resolveCursorSdk(repoRoot)
  for (const target of options.targets) await installTarget(target, helperRoot, { fetch: download })
  if (options.prune)
    for (const suffix of platformPackageSuffixesToPrune(options.targets)) {
      rmSync(path.join(helperRoot, `sdk-${suffix}`), { recursive: true, force: true })
    }
  if (!options.targets.length)
    console.log('[cursor-sdk] Windows ARM64: provider unavailable; continuing application build')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
