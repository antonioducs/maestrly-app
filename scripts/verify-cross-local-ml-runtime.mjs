#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import tar from 'tar-stream'

const WINDOWS_X64_TARGET = 'win-x64'
const WINDOWS_X64_MACHINE = 0x8664
const PE32_PLUS_MAGIC = 0x20b
const MAX_PE_HEADER_BYTES = 64 * 1024

export function assertWindowsX64Pe(header, archivePath) {
  if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error(`${archivePath}: expected a Windows PE file (missing MZ header)`)
  }
  const peOffset = header.readUInt32LE(0x3c)
  const optionalHeaderOffset = peOffset + 24
  if (optionalHeaderOffset + 2 > header.length) {
    throw new Error(`${archivePath}: PE header is outside the inspected prefix`)
  }
  if (header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`${archivePath}: expected a Windows PE signature`)
  }
  const machine = header.readUInt16LE(peOffset + 4)
  if (machine !== WINDOWS_X64_MACHINE) {
    throw new Error(`${archivePath}: expected PE32+ x86-64 machine 0x8664, found 0x${machine.toString(16)}`)
  }
  const optionalHeaderMagic = header.readUInt16LE(optionalHeaderOffset)
  if (optionalHeaderMagic !== PE32_PLUS_MAGIC) {
    throw new Error(
      `${archivePath}: expected PE32+ optional-header magic 0x20b, found 0x${optionalHeaderMagic.toString(16)}`
    )
  }
}

async function archiveDigest(archive) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { bytes, sha256: hash.digest('hex') }
}

function safeArchivePath(name) {
  const normalized = path.posix.normalize(name)
  const parts = name.split('/')
  if (
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.posix.isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    normalized !== name ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe archive entry: ${name || '(empty)'}`)
  }
  return normalized
}

function isTargetPeBinary(name) {
  return /\.(?:dll|node)$/.test(name)
}

async function inspectArchive(archive) {
  const names = new Set()
  const pePrefixes = new Map()
  let unpackedBytes = 0
  const extract = tar.extract()

  extract.on('entry', (header, stream, next) => {
    void (async () => {
      const name = safeArchivePath(header.name)
      if (header.type !== 'file') throw new Error(`${name}: expected a regular file, found ${header.type}`)
      if (names.has(name)) throw new Error(`Duplicate archive entry: ${name}`)
      names.add(name)

      const onnxTarget = /^node_modules\/onnxruntime-node\/bin\/napi-v3\/([^/]+)\/([^/]+)\//.exec(name)
      if (onnxTarget && (onnxTarget[1] !== 'win32' || onnxTarget[2] !== 'x64')) {
        throw new Error(`${name}: foreign ONNX native target leaked into ${WINDOWS_X64_TARGET}`)
      }
      if (/\.(?:dylib|so(?:\.\d+)*)$/.test(name)) {
        throw new Error(`${name}: non-Windows native library leaked into ${WINDOWS_X64_TARGET}`)
      }

      const inspectPe = isTargetPeBinary(name)
      const prefixChunks = []
      let prefixBytes = 0
      let actualBytes = 0
      for await (const chunk of stream) {
        actualBytes += chunk.length
        if (inspectPe && prefixBytes < MAX_PE_HEADER_BYTES) {
          const needed = Math.min(chunk.length, MAX_PE_HEADER_BYTES - prefixBytes)
          prefixChunks.push(chunk.subarray(0, needed))
          prefixBytes += needed
        }
      }
      if (actualBytes !== header.size) {
        throw new Error(`${name}: tar size mismatch (header=${header.size}, read=${actualBytes})`)
      }
      unpackedBytes += actualBytes
      if (inspectPe) pePrefixes.set(name, Buffer.concat(prefixChunks, prefixBytes))
      next()
    })().catch((error) => extract.destroy(error))
  })

  await pipeline(createReadStream(archive), createGunzip(), extract)
  return { names, pePrefixes, unpackedBytes }
}

export async function verifyCrossLocalMlRuntime({ archive, sidecar, target }) {
  if (target !== WINDOWS_X64_TARGET) {
    throw new Error(`Cross-runtime verification currently supports only ${WINDOWS_X64_TARGET}, received ${target}`)
  }

  const archivePath = path.resolve(archive)
  const sidecarPath = path.resolve(sidecar ?? archivePath.replace(/\.tar\.gz$/, '.json'))
  if (sidecarPath === archivePath) throw new Error(`Could not infer sidecar path from archive: ${archivePath}`)

  const metadata = JSON.parse(await readFile(sidecarPath, 'utf8'))
  const expectedArchiveName = `local-ml-runtime-${metadata.version}-${target}.tar.gz`
  if (
    metadata.schema !== 1 ||
    typeof metadata.version !== 'string' ||
    metadata.target !== target ||
    path.basename(archivePath) !== expectedArchiveName
  ) {
    throw new Error(`Sidecar schema/target mismatch: expected schema=1 target=${target}`)
  }

  const [{ bytes, sha256 }, inspected] = await Promise.all([archiveDigest(archivePath), inspectArchive(archivePath)])
  if (metadata.archiveBytes !== bytes) {
    throw new Error(`Archive byte count mismatch: sidecar=${metadata.archiveBytes}, actual=${bytes}`)
  }
  if (metadata.sha256 !== sha256) {
    throw new Error(`Archive SHA-256 mismatch: sidecar=${metadata.sha256}, actual=${sha256}`)
  }
  if (metadata.unpackedBytes !== inspected.unpackedBytes) {
    throw new Error(
      `Unpacked byte count mismatch: sidecar=${metadata.unpackedBytes}, actual=${inspected.unpackedBytes}`
    )
  }

  const requiredPaths = [
    'runtime.mjs',
    'node_modules/@xenova/transformers/package.json',
    'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
    'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll',
    'node_modules/sharp/package.json',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node',
    'node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.6.dll',
    'node_modules/@fugood/node-whisper-win32-x64/index.node',
    'models/ggml-silero-v6.2.0.bin',
  ]
  const missing = requiredPaths.filter((name) => !inspected.names.has(name))
  if (missing.length > 0) throw new Error(`Missing required ${target} archive paths: ${missing.join(', ')}`)

  if (!Array.isArray(metadata.criticalPaths)) throw new Error('Sidecar criticalPaths must be an array')
  const missingCritical = metadata.criticalPaths.filter((name) => !inspected.names.has(name))
  if (missingCritical.length > 0) {
    throw new Error(`Sidecar criticalPaths missing from archive: ${missingCritical.join(', ')}`)
  }
  const unsignedRequired = requiredPaths.filter((name) => !metadata.criticalPaths.includes(name))
  if (unsignedRequired.length > 0) {
    throw new Error(`Required paths absent from sidecar criticalPaths: ${unsignedRequired.join(', ')}`)
  }

  for (const [name, prefix] of inspected.pePrefixes) assertWindowsX64Pe(prefix, name)
  if (inspected.pePrefixes.size < 3) {
    throw new Error(`Expected multiple ${target} PE binaries, found ${inspected.pePrefixes.size}`)
  }

  return {
    archive: archivePath,
    sidecar: sidecarPath,
    target,
    files: inspected.names.size,
    peFiles: inspected.pePrefixes.size,
    bytes,
    unpackedBytes: inspected.unpackedBytes,
    sha256,
  }
}

function parseArgs(argv) {
  const positionals = []
  let target = null
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--target') target = argv[++index]
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`)
    else positionals.push(arg)
  }
  if (positionals.length !== 1 || !target) {
    throw new Error('Usage: node scripts/verify-cross-local-ml-runtime.mjs <archive.tar.gz> --target win-x64')
  }
  return { archive: positionals[0], target }
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  const result = await verifyCrossLocalMlRuntime(parseArgs(process.argv.slice(2)))
  console.log(
    `[verify-cross-local-ml-runtime] ok: ${result.target}, ${result.files} files, ${result.peFiles} PE x64 binaries, sha256=${result.sha256}`
  )
}
