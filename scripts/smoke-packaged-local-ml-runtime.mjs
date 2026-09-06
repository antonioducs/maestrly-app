#!/usr/bin/env node
/**
 * Runs the external local-ML runtime through the packaged Electron main process. This is intentionally a
 * separate gate from smoke-local-ml-runtime.mjs: the latter validates the archive under Node, while this one
 * launches the signed app and its utilityProcess helper with the exact runtime staged outside the app bundle.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'
import tar from 'tar-stream'

const run = promisify(execFile)
const dist = path.resolve(process.argv[2] ?? 'dist')
const packagedPlatform =
  process.platform === 'darwin'
    ? 'mac'
    : process.platform === 'win32'
      ? 'win'
      : process.platform === 'linux'
        ? 'linux'
        : null
if (!packagedPlatform) throw new Error(`Unsupported packaged local-ML smoke platform: ${process.platform}`)

const runtimeTarget = `${packagedPlatform}-${process.arch}`
const archive = path.resolve(
  process.argv[3] ??
    path.join('runtime-assets', 'local-ml', 'archives', `local-ml-runtime-2.17.2-1-${runtimeTarget}.tar.gz`)
)
if (process.argv.length > 4) throw new Error(`Unexpected extra arguments: ${process.argv.slice(4).join(' ')}`)

if (!existsSync(archive)) throw new Error(`Local-ML runtime archive not found: ${archive}`)

async function findDirectories(directory, predicate, depth = 6) {
  if (depth < 0) return []
  const matches = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(directory, entry.name)
    if (predicate(candidate, entry.name)) matches.push(candidate)
    matches.push(...(await findDirectories(candidate, predicate, depth - 1)))
  }
  return matches
}

async function newestZip(directory) {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    .map((entry) => path.join(directory, entry.name))
  const withStats = await Promise.all(candidates.map(async (candidate) => [candidate, (await stat(candidate)).mtimeMs]))
  return withStats.sort((a, b) => b[1] - a[1])[0]?.[0]
}

async function findUnpackedExecutable(unpackedRoot) {
  const entries = await readdir(unpackedRoot, { withFileTypes: true })
  if (packagedPlatform === 'win') {
    const candidates = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    if (candidates.length !== 1) {
      throw new Error(
        `Expected one main Windows executable under ${unpackedRoot}, found ${candidates.map((entry) => entry.name).join(', ') || 'none'}`
      )
    }
    return path.join(unpackedRoot, candidates[0].name)
  }

  if (packagedPlatform === 'linux') {
    const candidate = path.join(unpackedRoot, 'maestrly-app')
    const details = await stat(candidate).catch(() => null)
    if (!details?.isFile() || (details.mode & 0o111) === 0) {
      throw new Error(`Packaged Linux executable is missing or not executable: ${candidate}`)
    }
    return candidate
  }

  throw new Error(`Unsupported unpacked executable platform: ${packagedPlatform}`)
}

async function extractRuntime(destination) {
  const unpack = tar.extract()
  unpack.on('entry', (header, stream, next) => {
    void (async () => {
      const normalized = path.posix.normalize(header.name)
      if (path.posix.isAbsolute(header.name) || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Unsafe local-ML archive entry: ${header.name}`)
      }
      const output = path.join(destination, ...normalized.split('/'))
      if (header.type === 'directory') {
        await mkdir(output, { recursive: true })
        stream.resume()
      } else if (header.type === 'file') {
        await mkdir(path.dirname(output), { recursive: true })
        await new Promise((resolve, reject) => {
          const target = createWriteStream(output, { mode: header.mode })
          target.once('finish', resolve).once('error', reject)
          stream.once('error', reject).pipe(target)
        })
      } else {
        throw new Error(`Unsupported local-ML archive entry: ${header.name} (${header.type})`)
      }
      next()
    })().catch((error) => unpack.destroy(error))
  })
  const done = new Promise((resolve, reject) => unpack.once('finish', resolve).once('error', reject))
  createReadStream(archive).pipe(createGunzip()).pipe(unpack)
  await done
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'maestrly-packaged-ml-smoke-'))
try {
  const runtimePath = path.join(temporary, 'runtime')
  await mkdir(runtimePath, { recursive: true })
  await extractRuntime(runtimePath)
  if (!existsSync(path.join(runtimePath, 'runtime.mjs'))) throw new Error('Staged local-ML runtime.mjs is missing')

  let packagedRoot
  if (packagedPlatform === 'mac') {
    const zip = await newestZip(dist)
    packagedRoot = (await findDirectories(dist, (_candidate, name) => name.endsWith('.app')))[0]
    if (!packagedRoot && zip) {
      const extractedApp = path.join(temporary, 'app')
      await mkdir(extractedApp, { recursive: true })
      await run('/usr/bin/ditto', ['-x', '-k', zip, extractedApp], { timeout: 60_000 })
      packagedRoot = (await findDirectories(extractedApp, (_candidate, name) => name.endsWith('.app')))[0]
    }
    if (!packagedRoot) throw new Error(`Packaged macOS .app not found under ${dist}`)

    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', packagedRoot], { timeout: 60_000 })
    if (process.env.MAESTRLY_REQUIRE_HARDENED_RUNTIME === '1') {
      const entitlements = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', packagedRoot], {
        timeout: 60_000,
      })
      const signedText = `${entitlements.stdout}\n${entitlements.stderr}`
      if (!/<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/.test(signedText)) {
        throw new Error('Packaged macOS app is missing com.apple.security.cs.disable-library-validation')
      }
    }
  } else {
    const unpackedName = `${packagedPlatform}${process.arch === 'x64' ? '' : `-${process.arch}`}-unpacked`
    packagedRoot = (await findDirectories(dist, (_candidate, name) => name === unpackedName))[0]
    if (!packagedRoot)
      throw new Error(`Packaged ${packagedPlatform} unpacked directory not found under ${dist}: ${unpackedName}`)
  }

  let executablePath
  if (packagedPlatform === 'mac') {
    const macos = path.join(packagedRoot, 'Contents', 'MacOS')
    const executable = (await readdir(macos, { withFileTypes: true })).find((entry) => entry.isFile())
    if (!executable) throw new Error(`Packaged app executable not found under ${macos}`)
    executablePath = path.join(macos, executable.name)
  } else {
    executablePath = await findUnpackedExecutable(packagedRoot)
  }

  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RENDERER_URL
  delete childEnv.NODE_OPTIONS
  childEnv.AGENTS_E2E = '1'
  childEnv.AGENTS_USERDATA = path.join(temporary, 'user-data')
  childEnv.MAESTRLY_PACKAGED_LOCAL_ML_SMOKE = '1'
  childEnv.MAESTRLY_LOCAL_ML_RUNTIME_PATH = runtimePath

  const launchArgs =
    process.platform === 'darwin'
      ? ['--use-mock-keychain']
      : process.platform === 'linux'
        ? ['--no-sandbox']
        : []
  const child = spawn(executablePath, launchArgs, { cwd: dist, env: childEnv, stdio: 'inherit' })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000)
      reject(new Error('Timed out waiting for packaged local-ML smoke'))
    }, 180_000)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve(code ?? (signal ? 1 : 0))
    })
  })
  if (exitCode !== 0) throw new Error(`Packaged local-ML smoke exited with code ${exitCode}`)
  console.log(`[smoke-packaged-local-ml-runtime] ok: ${packagedRoot} + ${archive}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
