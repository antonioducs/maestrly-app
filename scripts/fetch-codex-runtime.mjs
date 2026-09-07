#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const CODEX_RUNTIME_VERSION = '0.153.4'

const TARGETS = [
  {
    id: 'mac-arm64',
    os: 'mac',
    arch: 'arm64',
    npmSuffix: 'darwin-arm64',
    triple: 'aarch64-apple-darwin',
    integrity: 'sha512-B1qhN3fa1ay0R0wGziXqgwSkB5icpYChNKHhtBHff/0UtSTC7z+l8aTtvMlGjH3E8HEvY3+njIJelM9CAAoVWg==',
  },
  {
    id: 'mac-x64',
    os: 'mac',
    arch: 'x64',
    npmSuffix: 'darwin-x64',
    triple: 'x86_64-apple-darwin',
    integrity: 'sha512-vnSbbPzfoDZmmyzsxswsDDXQ06IVFBzkQU7/hroB3ji93Ok2utcsq8Psfk2tjF5r9mEx8RWFJhzuTGHG26/NDA==',
  },
  {
    id: 'linux-arm64',
    os: 'linux',
    arch: 'arm64',
    npmSuffix: 'linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    integrity: 'sha512-QKdjYLYV4hXIuUQDP3P6F4NXuWFoKo9WUoV4nAREIx55kiUyi8UsYdsVobkeXir5n/maEQgYMCKLHVma4rNPiw==',
  },
  {
    id: 'linux-x64',
    os: 'linux',
    arch: 'x64',
    npmSuffix: 'linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    integrity: 'sha512-x1EcwBlY3AObM1VTUHNM2AzAJQsyreGdagpF+qFiYi/Oa30VBktvvG0C6tLtCzqW6hjZNWkGZQWmeVk7MuJKWg==',
  },
  {
    id: 'win-arm64',
    os: 'win',
    arch: 'arm64',
    npmSuffix: 'win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    integrity: 'sha512-/FBh42976ltF1kxDoPQBg1Q6+hwChRU5/sm5dfeC8kFVQMvOCGoGeY5d8rRZGVJE8XojlXo74VQb0sHowcfgBw==',
  },
  {
    id: 'win-x64',
    os: 'win',
    arch: 'x64',
    npmSuffix: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    integrity: 'sha512-lMkB43kJZH0VFr+hoXc11qqR7QtQIbkr07ALgj4urKL1osNyUyuy1iXd3Vzz2iCYvBUCSw7I0l/W1cEPGx9euQ==',
  },
]

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = path.join(root, 'resources', 'codex')
const MANIFEST_FILE = '.manifest-sha512.json'
const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
const hostId = `${hostOs}-${process.arch}`

function note(message) {
  console.log(`[fetch-codex-runtime] ${message}`)
}

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
    if (!Number.isSafeInteger(size) || size < 0) fail(`invalid tar entry: ${prefix ? `${prefix}/` : ''}${name}`)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) fail(`truncated tarball at ${prefix ? `${prefix}/` : ''}${name}`)
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
  const parts = raw.split('/')
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    fail(`unsafe tarball path: ${raw}`)
  }
  return parts
}

function requiredExecutable(target, tripleRoot) {
  return path.join(tripleRoot, 'bin', target.os === 'win' ? 'codex.exe' : 'codex')
}

function targetManifest(target, destination) {
  const tripleRoot = path.join(destination, target.triple)
  const files = []
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        visit(absolute, relative)
        continue
      }
      if (!stat.isFile()) fail(`runtime contains a non-regular entry: ${target.triple}/${relative}`)
      files.push({
        path: relative,
        size: stat.size,
        sha512: createHash('sha512').update(readFileSync(absolute)).digest('base64'),
        ...(target.os !== 'win' ? { executable: (stat.mode & 0o111) !== 0 } : {}),
      })
    }
  }
  visit(tripleRoot)
  return { schema: 1, version: CODEX_RUNTIME_VERSION, target: target.id, triple: target.triple, files }
}

function targetReady(target, destination) {
  const versionFile = path.join(destination, '.version')
  const tripleRoot = path.join(destination, target.triple)
  const manifestFile = path.join(destination, MANIFEST_FILE)
  const binary = requiredExecutable(target, tripleRoot)
  if (!existsSync(versionFile) || !existsSync(binary) || !existsSync(manifestFile)) return false
  if (!existsSync(path.join(tripleRoot, 'codex-package.json'))) return false
  if (readFileSync(versionFile, 'utf8').trim() !== CODEX_RUNTIME_VERSION) return false
  if (target.os !== 'win' && (statSync(binary).mode & 0o111) === 0) return false
  try {
    const expected = JSON.parse(readFileSync(manifestFile, 'utf8'))
    return JSON.stringify(targetManifest(target, destination)) === JSON.stringify(expected)
  } catch {
    return false
  }
}

function finalizeTarget(target, temporary, destination, source) {
  const tripleRoot = path.join(temporary, target.triple)
  const binary = requiredExecutable(target, tripleRoot)
  if (!existsSync(binary)) fail(`extracted runtime is missing ${path.relative(temporary, binary)}`)
  if (!existsSync(path.join(tripleRoot, 'codex-package.json'))) {
    fail(`extracted runtime is missing ${target.triple}/codex-package.json`)
  }

  writeFileSync(path.join(temporary, MANIFEST_FILE), `${JSON.stringify(targetManifest(target, temporary), null, 2)}\n`)
  writeFileSync(path.join(temporary, '.version'), `${CODEX_RUNTIME_VERSION}\n`)
  writeFileSync(path.join(temporary, '.source'), `${source}\n`)
  rmSync(destination, { recursive: true, force: true })
  renameSync(temporary, destination)
  note(`${target.id}: ok (${path.relative(root, binary.replace(temporary, destination))})`)
}

function tryInstalledPackage(target, temporary) {
  const packageRoot = path.join(root, 'node_modules', '@openai', `codex-${target.npmSuffix}`)
  const packageJson = path.join(packageRoot, 'package.json')
  if (!existsSync(packageJson)) return false

  let version
  try {
    version = JSON.parse(readFileSync(packageJson, 'utf8')).version
  } catch (error) {
    fail(`${path.relative(root, packageJson)} invalid: ${error.message}`)
  }
  const expectedVersion = `${CODEX_RUNTIME_VERSION}-${target.npmSuffix}`
  if (version !== expectedVersion) {
    fail(`${path.relative(root, packageJson)} has version ${version}; expected ${expectedVersion}`)
  }

  const source = path.join(packageRoot, 'vendor', target.triple)
  if (!existsSync(requiredExecutable(target, source))) return false
  mkdirSync(temporary, { recursive: true })
  cpSync(source, path.join(temporary, target.triple), { recursive: true, force: true })
  return true
}

function extractVendor(target, tarball, temporary) {
  const prefix = `package/vendor/${target.triple}/`
  const archive = gunzipSync(tarball)
  let files = 0

  for (const entry of tarEntries(archive)) {
    if (!entry.name.startsWith(prefix)) continue
    const relative = entry.name.slice(prefix.length)
    if (!relative) continue
    const output = path.join(temporary, target.triple, ...safeRelativePath(relative))

    if (entry.type === '5') {
      mkdirSync(output, { recursive: true })
      continue
    }
    if (entry.type !== '0' && entry.type !== '\0') {
      fail(`unsupported tar type (${JSON.stringify(entry.type)}) in ${entry.name}`)
    }

    mkdirSync(path.dirname(output), { recursive: true })
    writeFileSync(output, entry.data)
    if (target.os !== 'win' && (entry.mode & 0o111) !== 0) chmodSync(output, entry.mode & 0o777)
    files++
  }

  if (files === 0) fail(`tarball is missing ${prefix}`)
}

async function downloadTarget(target, temporary) {
  const version = `${CODEX_RUNTIME_VERSION}-${target.npmSuffix}`
  const url = `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`
  note(`${target.id}: downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) fail(`download failed (${response.status}) for ${url}`)
  const tarball = Buffer.from(await response.arrayBuffer())

  const actual = createHash('sha512').update(tarball).digest('base64')
  const expected = target.integrity.replace(/^sha512-/, '')
  if (actual !== expected) {
    fail(`integrity mismatch for @openai/codex@${version} (expected ${expected}, received ${actual})`)
  }
  extractVendor(target, tarball, temporary)
}

async function materializeTarget(target, options) {
  const destination = path.join(outRoot, target.id)
  if (!options.force && targetReady(target, destination)) {
    note(`${target.id}: already at v${CODEX_RUNTIME_VERSION} — skipping`)
    return
  }

  mkdirSync(outRoot, { recursive: true })
  const temporary = path.join(outRoot, `.${target.id}.tmp-${process.pid}`)
  rmSync(temporary, { recursive: true, force: true })

  try {
    if (!options.download && tryInstalledPackage(target, temporary)) {
      finalizeTarget(target, temporary, destination, 'npm-installed-optional-package')
      return
    }
    await downloadTarget(target, temporary)
    finalizeTarget(target, temporary, destination, `registry-tarball ${target.integrity}`)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function parseArgs(argv) {
  const ids = []
  let all = false
  let force = false
  let download = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') all = true
    else if (arg === '--force') force = true
    else if (arg === '--download') download = true
    else if (arg === '--target') {
      const value = argv[++i]
      if (!value) fail('--target requires <os>-<arch>')
      ids.push(value)
    } else if (arg.startsWith('--target=')) ids.push(arg.slice('--target='.length))
    else fail(`unknown flag: ${arg}`)
  }

  if (all && ids.length > 0) fail('use --all OR --target, not both')
  const selectedIds = all ? TARGETS.map((target) => target.id) : ids.length > 0 ? ids : [hostId]
  const uniqueIds = [...new Set(selectedIds)]
  const targets = uniqueIds.map((id) => {
    const target = TARGETS.find((candidate) => candidate.id === id)
    if (!target) fail(`unsupported target: ${id}. Use: ${TARGETS.map((candidate) => candidate.id).join(', ')}`)
    return target
  })
  return { targets, force, download }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  for (const target of options.targets) await materializeTarget(target, options)
}

main().catch((error) => {
  console.error(`[fetch-codex-runtime] ERROR: ${error.message}`)
  process.exit(1)
})
