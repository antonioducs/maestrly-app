#!/usr/bin/env node
// Materialize verified optional SDK helpers for one packaging target.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
export const CURSOR_SDK_VERSION = '1.0.31'
// npm dist.integrity, verified 2026-09-19. Upgrades require deliberate repinning.
export const TARGETS = [
  {
    id: 'mac-arm64',
    npmSuffix: 'darwin-arm64',
    integrity: 'sha512-i6INDIQhV7xDeFKfND0yr/SOwv4uJthPMfXXvNpZapO+IbJTx30aPzJVMBqdksvDHyn/cekJB/92Jkz+a5K8Ow==',
  },
  {
    id: 'mac-x64',
    npmSuffix: 'darwin-x64',
    integrity: 'sha512-vCmrGykwflJNAAr4RVY4UlZ+F0fmUF+WCR8zFzP4Jl1Da2b8Oh1rxrVLbIbleS1/LKsX/OPbTQNRL0SEER95Sg==',
  },
  {
    id: 'linux-arm64',
    npmSuffix: 'linux-arm64',
    integrity: 'sha512-BHTwumfhWjTy0k41+KaaXfTm3MGu6WEYU76FmXqc/r1+ynuQroqfBKWyfH4XBcx3uzyaZJQLxNB9BBbs8yHUig==',
  },
  {
    id: 'linux-x64',
    npmSuffix: 'linux-x64',
    integrity: 'sha512-y+ahiKQvEISUn9y6z75jwKjLQkrJ/nY7ehL1Vi9X8zdbjz14fiEtMTICAHccTiTq5cf6dZjXC5QfPdJRat6dhg==',
  },
  {
    id: 'win-x64',
    npmSuffix: 'win32-x64',
    integrity: 'sha512-5ti4AwUz8kh5ovM86K/fTiHmVGL6jk1faQkTCX08lcCxFSlUDwpeyhn90pWsbNFQ4Vy2PttqEjanV6895p13eA==',
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
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const sdk = JSON.parse(readFileSync(path.join(root, 'node_modules/@cursor/sdk/package.json'), 'utf8'))
  if (sdk.version !== CURSOR_SDK_VERSION) fail(`Expected @cursor/sdk ${CURSOR_SDK_VERSION}, found ${sdk.version}`)
  for (const target of options.targets) {
    const destination = path.join(root, 'node_modules/@cursor', `sdk-${target.npmSuffix}`)
    const temporary = `${destination}.tmp-${process.pid}`
    rmSync(temporary, { recursive: true, force: true })
    try {
      const url = `https://registry.npmjs.org/@cursor/sdk-${target.npmSuffix}/-/sdk-${target.npmSuffix}-${CURSOR_SDK_VERSION}.tgz`
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
      if (!response.ok) fail(`Download failed (${response.status}): ${url}`)
      const tarball = Buffer.from(await response.arrayBuffer())
      verifyIntegrity(tarball, target.integrity)
      extractPackage(tarball, temporary)
      const pkg = JSON.parse(readFileSync(path.join(temporary, 'package.json'), 'utf8'))
      if (
        pkg.name !== `@cursor/sdk-${target.npmSuffix}` ||
        pkg.version !== CURSOR_SDK_VERSION ||
        !existsSync(path.join(temporary, 'vendor/tree-sitter/index.js'))
      )
        fail('Invalid SDK platform package')
      rmSync(destination, { recursive: true, force: true })
      renameSync(temporary, destination)
      console.log(`[cursor-sdk] Verified ${target.id}@${CURSOR_SDK_VERSION}`)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  if (options.prune)
    for (const suffix of platformPackageSuffixesToPrune(options.targets)) {
      rmSync(path.join(root, 'node_modules/@cursor', `sdk-${suffix}`), { recursive: true, force: true })
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
