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

export const GITHUB_COPILOT_RUNTIME_VERSION = '1.0.71'

const TARGETS = [
  {
    id: 'mac-arm64',
    os: 'mac',
    arch: 'arm64',
    npmSuffix: 'darwin-arm64',
    integrity: 'sha512-mEWzyqbqRAWgyU7i2uuSRoVPx/TwaFQX0nZmw0bc30aJ0BnO7cy2kYQyCHw8ykmf/tfxT0xauZ6k0BOFmWizzQ==',
  },
  {
    id: 'mac-x64',
    os: 'mac',
    arch: 'x64',
    npmSuffix: 'darwin-x64',
    integrity: 'sha512-Md9yEg406OBVBx3w4PeEj62TubulVLBcHleqmCoOoUmPgUxPZotUbrqz3rtbzADbXfrrD7JWvVsbd2UiNL194w==',
  },
  {
    id: 'linux-arm64',
    os: 'linux',
    arch: 'arm64',
    npmSuffix: 'linux-arm64',
    integrity: 'sha512-ykLJYOqBj3jRB5IJCDugLClAqbr7DmtTbUjlNY7+Jdq/n6i+d7xUQGclf1IWL5gnxbGQVAf+zkToD+sRM389Kg==',
  },
  {
    id: 'linux-x64',
    os: 'linux',
    arch: 'x64',
    npmSuffix: 'linux-x64',
    integrity: 'sha512-pC0FNHG+BBwZd6yZlM85kkAGN+uJhM6o+THi76N2GnnSxmw7+remb1mvYxdgRVbdCm+LBUIbCKRWJLuMwrfb6A==',
  },
  {
    id: 'win-arm64',
    os: 'win',
    arch: 'arm64',
    npmSuffix: 'win32-arm64',
    integrity: 'sha512-+HI1DokixXhHUahj06Fw67ZAigBuXKC58BFma4UJOGrQsDgwOSbqeTQHCw6vuymzjKlg3sactfsCUTaefkjscQ==',
  },
  {
    id: 'win-x64',
    os: 'win',
    arch: 'x64',
    npmSuffix: 'win32-x64',
    integrity: 'sha512-02kXOBd9CwBbCaztuf71WYWn+uGapCuiaasomN4tcMH3HBVZ4gi3J0ZUoRcgcS80xh81uQyeBHbnUKzb/RE/9A==',
  },
]

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repositoryRoot, 'apps', 'desktop')
const outRoot = path.join(root, 'resources', 'github-copilot')
const PACKAGE_DIR = 'package'
const MANIFEST_FILE = '.manifest-sha512.json'
const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
const hostId = `${hostOs}-${process.arch}`

function note(message) {
  console.log(`[fetch-github-copilot-runtime] ${message}`)
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

function runtimeRoot(destination) {
  return path.join(destination, PACKAGE_DIR)
}

function requiredExecutable(target, destination) {
  return path.join(runtimeRoot(destination), target.os === 'win' ? 'copilot.exe' : 'copilot')
}

function targetManifest(target, destination) {
  const packageRoot = runtimeRoot(destination)
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
      if (!stat.isFile()) fail(`runtime contains a non-regular entry: ${relative}`)
      files.push({
        path: relative,
        size: stat.size,
        sha512: createHash('sha512').update(readFileSync(absolute)).digest('base64'),
        ...(target.os !== 'win' ? { executable: (stat.mode & 0o111) !== 0 } : {}),
      })
    }
  }
  visit(packageRoot)
  return {
    schema: 1,
    version: GITHUB_COPILOT_RUNTIME_VERSION,
    target: target.id,
    integrity: target.integrity,
    files,
  }
}

function targetReady(target, destination) {
  const versionFile = path.join(destination, '.version')
  const manifestFile = path.join(destination, MANIFEST_FILE)
  const binary = requiredExecutable(target, destination)
  const packageJson = path.join(runtimeRoot(destination), 'package.json')
  const license = path.join(runtimeRoot(destination), 'LICENSE.md')
  if (![versionFile, manifestFile, binary, packageJson, license].every(existsSync)) return false
  if (readFileSync(versionFile, 'utf8').trim() !== GITHUB_COPILOT_RUNTIME_VERSION) return false
  if (target.os !== 'win' && (statSync(binary).mode & 0o111) === 0) return false
  try {
    const metadata = JSON.parse(readFileSync(packageJson, 'utf8'))
    if (metadata.version !== GITHUB_COPILOT_RUNTIME_VERSION) return false
    const expected = JSON.parse(readFileSync(manifestFile, 'utf8'))
    return JSON.stringify(targetManifest(target, destination)) === JSON.stringify(expected)
  } catch {
    return false
  }
}

function finalizeTarget(target, temporary, destination, source) {
  const binary = requiredExecutable(target, temporary)
  const packageJson = path.join(runtimeRoot(temporary), 'package.json')
  const license = path.join(runtimeRoot(temporary), 'LICENSE.md')
  if (!existsSync(binary)) fail(`extracted runtime is missing ${path.relative(temporary, binary)}`)
  if (!existsSync(packageJson)) fail(`extracted runtime is missing ${PACKAGE_DIR}/package.json`)
  if (!existsSync(license)) fail(`extracted runtime is missing ${PACKAGE_DIR}/LICENSE.md`)

  const metadata = JSON.parse(readFileSync(packageJson, 'utf8'))
  if (metadata.version !== GITHUB_COPILOT_RUNTIME_VERSION) {
    fail(`${PACKAGE_DIR}/package.json has version ${metadata.version}; expected ${GITHUB_COPILOT_RUNTIME_VERSION}`)
  }
  if (target.os !== 'win' && (statSync(binary).mode & 0o111) === 0) {
    fail(`${path.relative(temporary, binary)} is not executable`)
  }

  writeFileSync(path.join(temporary, MANIFEST_FILE), `${JSON.stringify(targetManifest(target, temporary), null, 2)}\n`)
  writeFileSync(path.join(temporary, '.version'), `${GITHUB_COPILOT_RUNTIME_VERSION}\n`)
  writeFileSync(path.join(temporary, '.source'), `${source}\n`)
  rmSync(destination, { recursive: true, force: true })
  renameSync(temporary, destination)
  note(`${target.id}: ok (${path.relative(root, binary.replace(temporary, destination))})`)
}

function tryInstalledPackage(target, temporary) {
  const packageRoot = path.join(repositoryRoot, 'node_modules', '@github', `copilot-${target.npmSuffix}`)
  const packageJson = path.join(packageRoot, 'package.json')
  if (!existsSync(packageJson)) return false

  let version
  try {
    version = JSON.parse(readFileSync(packageJson, 'utf8')).version
  } catch (error) {
    fail(`${path.relative(root, packageJson)} invalid: ${error.message}`)
  }
  if (version !== GITHUB_COPILOT_RUNTIME_VERSION) {
    fail(`${path.relative(root, packageJson)} has version ${version}; expected ${GITHUB_COPILOT_RUNTIME_VERSION}`)
  }

  const binary = path.join(packageRoot, target.os === 'win' ? 'copilot.exe' : 'copilot')
  if (!existsSync(binary)) return false
  mkdirSync(temporary, { recursive: true })
  cpSync(packageRoot, runtimeRoot(temporary), { recursive: true, force: true })
  return true
}

function extractPackage(target, tarball, temporary) {
  const prefix = 'package/'
  const archive = gunzipSync(tarball)
  let files = 0

  for (const entry of tarEntries(archive)) {
    if (!entry.name.startsWith(prefix)) continue
    const relative = entry.name.slice(prefix.length)
    if (!relative) continue
    const output = path.join(runtimeRoot(temporary), ...safeRelativePath(relative))

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
  const packageName = `copilot-${target.npmSuffix}`
  const url = `https://registry.npmjs.org/@github/${packageName}/-/${packageName}-${GITHUB_COPILOT_RUNTIME_VERSION}.tgz`
  note(`${target.id}: downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) fail(`download failed (${response.status}) for ${url}`)
  const tarball = Buffer.from(await response.arrayBuffer())

  const actual = createHash('sha512').update(tarball).digest('base64')
  const expected = target.integrity.replace(/^sha512-/, '')
  if (actual !== expected) {
    fail(
      `integrity mismatch for @github/${packageName}@${GITHUB_COPILOT_RUNTIME_VERSION} (expected ${expected}, received ${actual})`
    )
  }
  extractPackage(target, tarball, temporary)
}

async function materializeTarget(target, options) {
  const destination = path.join(outRoot, target.id)
  if (!options.force && targetReady(target, destination)) {
    note(`${target.id}: already at v${GITHUB_COPILOT_RUNTIME_VERSION} — skipping`)
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
  console.error(`[fetch-github-copilot-runtime] ERROR: ${error.message}`)
  process.exit(1)
})
