#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'
import { ensureLocalMlDependencies } from './local-ml-npm.mjs'
import { signMacRuntimeEntries } from './sign-macos-runtime.mjs'
import tar from 'tar-stream'

export const LOCAL_ML_RUNTIME_VERSION = '2.17.2-1'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
const hostTarget = `${hostOs}-${process.arch}`
const requested = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : hostTarget
const supportedTargets = new Set(['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-arm64', 'win-x64'])
const crossBuildAllowed = hostTarget === 'mac-arm64' && requested === 'win-x64'

if (!supportedTargets.has(requested)) {
  throw new Error(`Unsupported local ML runtime target: ${requested}`)
}
if (requested !== hostTarget && !crossBuildAllowed) {
  throw new Error(`Refusing unsupported local ML cross-build ${hostTarget} -> ${requested}`)
}

const [requestedOs, requestedArch] = requested.split('-')
const requestedPlatform = requestedOs === 'mac' ? 'darwin' : requestedOs === 'win' ? 'win32' : requestedOs
// Preserve existing archive encoding; Windows archives use canonical metadata for cross-build parity.
const crossHostCanonicalArchive = requested === 'win-x64'

function compareArchiveText(left, right) {
  if (!crossHostCanonicalArchive) return left.localeCompare(right)
  return left < right ? -1 : left > right ? 1 : 0
}

const buildRoot = path.join(root, 'runtime-assets', 'local-ml')
const sourcePackage = path.join(buildRoot, 'node_modules', '@xenova', 'transformers', 'package.json')
ensureLocalMlDependencies({
  cwd: buildRoot,
  sourcePackage,
  installTarget: requested,
  targetPlatform: requestedPlatform,
  targetArch: requestedArch,
})
const sourceVersion = JSON.parse(await readFile(sourcePackage, 'utf8')).version
if (sourceVersion !== '2.17.2') throw new Error(`Expected @xenova/transformers 2.17.2, found ${sourceVersion}`)

function packageDirectory(name, fromDirectory) {
  let cursor = fromDirectory
  while (true) {
    const candidate = path.join(cursor, 'node_modules', ...name.split('/'))
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(`Installed dependency ${name} was not found from ${fromDirectory}`)
}

const packages = new Map()
async function collectPackage(name, fromDirectory = buildRoot, optional = false) {
  let directory
  try {
    directory = packageDirectory(name, fromDirectory)
  } catch (error) {
    if (optional) return
    throw error
  }
  const relative = path.relative(buildRoot, directory).replaceAll(path.sep, '/')
  if (packages.has(relative)) return
  packages.set(relative, directory)
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    await collectPackage(dependency, directory)
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
    await collectPackage(dependency, directory, true)
  }
}
await collectPackage('@xenova/transformers')

function includeTargetFile(relative) {
  const normalized = relative.replaceAll(path.sep, '/')
  const onnx = normalized.match(/node_modules\/onnxruntime-node\/bin\/napi-v3\/([^/]+)\/([^/]+)\//)
  if (onnx) {
    return onnx[1] === requestedPlatform && onnx[2] === requestedArch
  }
  if (normalized.includes('/node_modules/@xenova/transformers/dist/')) return false
  if (/\.(?:map|tsbuildinfo)$/.test(normalized)) return false
  return true
}

const entries = [{ archive: 'runtime.mjs', source: path.join(root, 'runtime-assets', 'local-ml', 'runtime.mjs') }]
async function visit(directory, archiveDirectory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).then((items) =>
    items.sort((a, b) => compareArchiveText(a.name, b.name))
  )) {
    // Dependencies are collected from manifests and emitted exactly once at their resolved install path.
    if (entry.name === 'node_modules') continue
    const source = path.join(directory, entry.name)
    const archive = `${archiveDirectory}/${entry.name}`
    const info = await lstat(source)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) await visit(source, archive)
    else if (info.isFile() && includeTargetFile(archive)) entries.push({ archive, source })
  }
}
for (const [relative, directory] of [...packages].sort(([a], [b]) => compareArchiveText(a, b)))
  await visit(directory, relative)
entries.sort((a, b) => compareArchiveText(a.archive, b.archive))
const signedMachO =
  requestedPlatform === 'darwin' ? await signMacRuntimeEntries(entries, { cscName: process.env.CSC_NAME }) : []

async function archiveEntryContent(entry) {
  if (!crossHostCanonicalArchive || entry.archive !== 'runtime.mjs') return null
  // A Windows checkout may materialize the tracked entrypoint with CRLF. Normalize the only repo-owned file
  // in the archive so native Windows and macOS cross-builds hash the same bytes.
  return Buffer.from((await readFile(entry.source, 'utf8')).replace(/\r\n?/g, '\n'))
}

const entryMetadata = new Map()
let unpackedBytes = 0
for (const entry of entries) {
  const info = await lstat(entry.source)
  const content = await archiveEntryContent(entry)
  const size = content?.length ?? info.size
  const mode = crossHostCanonicalArchive ? 0o644 : info.mode & 0o111 ? 0o755 : 0o644
  entryMetadata.set(entry.archive, { content, mode, size })
  unpackedBytes += size
}

const outputDirectory = path.join(root, 'runtime-assets', 'local-ml', 'archives')
await mkdir(outputDirectory, { recursive: true })
const output = path.join(outputDirectory, `local-ml-runtime-${LOCAL_ML_RUNTIME_VERSION}-${requested}.tar.gz`)
const temporary = `${output}.tmp`
await rm(temporary, { force: true })
const pack = tar.pack()
const gzip = createGzip(crossHostCanonicalArchive ? { level: 9 } : { level: 9, mtime: 0 })
const destination = createWriteStream(temporary, { flags: 'wx' })
pack.pipe(gzip).pipe(destination)

for (const entry of entries) {
  const metadata = entryMetadata.get(entry.archive)
  await new Promise((resolve, reject) => {
    const target = pack.entry(
      {
        name: entry.archive,
        size: metadata.size,
        // win-x64 can come from macOS or Windows. Fixed modes keep NTFS/npm differences out of its hash.
        mode: metadata.mode,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
      },
      (error) => (error ? reject(error) : resolve())
    )
    if (metadata.content) target.end(metadata.content)
    else createReadStream(entry.source).on('error', reject).pipe(target)
  })
}
pack.finalize()
await new Promise((resolve, reject) => destination.once('close', resolve).once('error', reject).once('finish', resolve))

if (crossHostCanonicalArchive) {
  // zlib writes a host-specific gzip OS byte (Darwin=0x13, Windows=0x00). It is informational and not
  // covered by the payload CRC, so canonicalize win-x64 to keep its hash stable across supported hosts.
  const gzipFile = await open(temporary, 'r+')
  try {
    const header = Buffer.alloc(10)
    const { bytesRead } = await gzipFile.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 0x08) {
      throw new Error('Generated local ML archive does not have a valid gzip header')
    }
    await gzipFile.write(Buffer.from([0xff]), 0, 1, 9)
  } finally {
    await gzipFile.close()
  }
}
await rm(output, { force: true })
await (await import('node:fs/promises')).rename(temporary, output)

const hash = createHash('sha256')
let bytes = 0
for await (const chunk of createReadStream(output)) {
  hash.update(chunk)
  bytes += chunk.length
}
const sha256 = hash.digest('hex')
const manifestPath = path.join(buildRoot, 'manifest.json')
const previous = existsSync(manifestPath)
  ? JSON.parse(await readFile(manifestPath, 'utf8'))
  : { schema: 1, version: LOCAL_ML_RUNTIME_VERSION, targets: {} }
if (previous.schema !== 1 || previous.version !== LOCAL_ML_RUNTIME_VERSION) {
  throw new Error('local ML manifest schema/version does not match the build package')
}
const nativeRoot = `node_modules/onnxruntime-node/bin/napi-v3/${requestedPlatform}/${requestedArch}`
const nativeCritical = entries
  .map((entry) => entry.archive)
  .filter(
    (entry) =>
      entry.startsWith(`${nativeRoot}/`) && /(?:binding\.node|libonnxruntime[^/]*|onnxruntime[^/]*\.dll)$/.test(entry)
  )
const sharpCritical = entries
  .map((entry) => entry.archive)
  .filter(
    (entry) =>
      entry.startsWith('node_modules/@img/') && /(?:\.node|\.dll|\.dylib|\.so(?:\.\d+)*)$/.test(entry)
  )
previous.targets[requested] = {
  sha256,
  archiveBytes: bytes,
  unpackedBytes,
  criticalPaths: [
    'runtime.mjs',
    'node_modules/@xenova/transformers/package.json',
    ...nativeCritical,
    'node_modules/sharp/package.json',
    ...sharpCritical,
  ],
}
await writeFile(manifestPath, `${JSON.stringify(previous, null, 2)}\n`)
await writeFile(
  path.join(outputDirectory, `local-ml-runtime-${LOCAL_ML_RUNTIME_VERSION}-${requested}.json`),
  `${JSON.stringify({ schema: 1, version: LOCAL_ML_RUNTIME_VERSION, target: requested, ...previous.targets[requested] }, null, 2)}\n`
)
console.log(
  JSON.stringify(
    {
      target: requested,
      version: LOCAL_ML_RUNTIME_VERSION,
      archive: path.relative(root, output),
      bytes,
      unpackedBytes,
      sha256,
      files: entries.length,
      signedMachOFiles: signedMachO.length,
    },
    null,
    2
  )
)
