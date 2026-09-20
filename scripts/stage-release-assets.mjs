#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/

/**
 * Definition order is the staging order: binaries are staged first so their public names are known
 * when the updater metadata (`latest*.yml`) is rewritten. `binary` files are the published
 * installers, `blockmap` files are the differential-download indexes electron-updater derives from
 * each installer URL, and `metadata` files are the update feed manifests.
 */
export const RELEASE_ASSET_DEFINITIONS = Object.freeze({
  linux: Object.freeze([
    Object.freeze({
      kind: 'binary',
      suffix: '.AppImage',
      output: (version) => `Maestrly-App-${version}-linux-x64.AppImage`,
    }),
    Object.freeze({ kind: 'binary', suffix: '.deb', output: (version) => `Maestrly-App-${version}-linux-x64.deb` }),
    Object.freeze({ kind: 'metadata', suffix: 'latest-linux.yml', output: () => 'latest-linux.yml' }),
  ]),
  windows: Object.freeze([
    Object.freeze({ kind: 'binary', suffix: '.exe', output: (version) => `Maestrly-App-${version}-windows-x64.exe` }),
    Object.freeze({
      kind: 'blockmap',
      suffix: '.exe.blockmap',
      output: (version) => `Maestrly-App-${version}-windows-x64.exe.blockmap`,
    }),
    Object.freeze({ kind: 'metadata', suffix: 'latest.yml', output: () => 'latest.yml' }),
  ]),
  macos: Object.freeze([
    Object.freeze({ kind: 'binary', suffix: '.dmg', output: (version) => `Maestrly-App-${version}-macos-arm64.dmg` }),
    Object.freeze({ kind: 'binary', suffix: '.zip', output: (version) => `Maestrly-App-${version}-macos-arm64.zip` }),
    Object.freeze({
      kind: 'blockmap',
      suffix: '.zip.blockmap',
      output: (version) => `Maestrly-App-${version}-macos-arm64.zip.blockmap`,
    }),
    Object.freeze({ kind: 'metadata', suffix: 'latest-mac.yml', output: () => 'latest-mac.yml' }),
  ]),
})

/** Installers must not absorb their own blockmap, and feed manifests keep their exact published name. */
function matchesDefinition(name, definition) {
  if (definition.kind === 'metadata') return name === definition.suffix
  if (definition.kind === 'binary') return name.endsWith(definition.suffix) && !name.endsWith('.blockmap')
  return name.endsWith(definition.suffix)
}

/**
 * electron-builder writes URL-safe names in the manifests, so a file packaged as
 * `Maestrly App-0.7.0-arm64-mac.zip` is referenced as `Maestrly-App-0.7.0-arm64-mac.zip`. Every
 * variant must map to the published name, otherwise the updater downloads a URL that does not exist.
 */
function nameVariants(name) {
  return [...new Set([name, name.replaceAll(' ', '-'), name.replaceAll(' ', '%20')])]
}

/**
 * Rewrite build-time artifact names to the published ones inside an updater manifest. Longest names
 * are replaced first so a shorter name never truncates a longer one, and checksums stay untouched.
 */
function rewriteUpdaterMetadata(content, renames) {
  let rewritten = content
  for (const [original, staged] of [...renames].sort(([left], [right]) => right.length - left.length)) {
    rewritten = rewritten.split(original).join(staged)
  }
  return rewritten
}

/** A manifest pointing at a file the release will not contain would break every client update. */
function assertMetadataReferences(manifest, file, stagedNames) {
  const referenced = [...manifest.matchAll(/^\s*(?:-\s+url|path):\s*(.+?)\s*$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, '')
  )
  for (const reference of referenced) {
    if (!stagedNames.has(reference)) {
      throw new Error(`Updater metadata ${file} references an unpublished artifact: ${reference}`)
    }
  }
}

function resolvePath(value, label) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') throw new Error(`${label} must use the file protocol`)
    return fileURLToPath(value)
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty path`)
  return path.resolve(value)
}

async function ensureEmptyOutputDirectory(outputDir) {
  try {
    await access(outputDir)
  } catch {
    await mkdir(outputDir, { recursive: true })
    return
  }

  const details = await lstat(outputDir)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Release output path must be a directory: ${outputDir}`)
  }
  if ((await readdir(outputDir)).length > 0) throw new Error(`Release output directory must be empty: ${outputDir}`)
}

export async function stageReleaseAssets({ platform, sourceDir, outputDir, version }) {
  const definitions = RELEASE_ASSET_DEFINITIONS[platform]
  if (!definitions) throw new Error(`Unsupported release platform: ${platform}`)
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
  }

  const source = resolvePath(sourceDir, 'Release source directory')
  const output = resolvePath(outputDir, 'Release output directory')
  const sourceDetails = await stat(source)
  if (!sourceDetails.isDirectory()) throw new Error(`Release source path must be a directory: ${source}`)
  await ensureEmptyOutputDirectory(output)

  const entries = await readdir(source, { withFileTypes: true })
  const staged = []
  const stagedNames = new Set()
  const renames = new Map()
  for (const definition of definitions) {
    const candidates = entries.filter((entry) => matchesDefinition(entry.name, definition))
    if (candidates.length !== 1) {
      throw new Error(`Expected exactly one ${definition.suffix} release artifact; found ${candidates.length}`)
    }

    const [candidate] = candidates
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      throw new Error(`Release artifact must be a regular file: ${candidate.name}`)
    }
    const sourceFile = path.join(source, candidate.name)
    if ((await stat(sourceFile)).size === 0) throw new Error(`Release artifact is empty: ${candidate.name}`)

    const outputName = definition.output(version)
    const destination = path.join(output, outputName)
    if (definition.kind === 'metadata') {
      const manifest = rewriteUpdaterMetadata(await readFile(sourceFile, 'utf8'), renames)
      assertMetadataReferences(manifest, outputName, stagedNames)
      await writeFile(destination, manifest, { flag: 'wx' })
    } else {
      for (const variant of nameVariants(candidate.name)) renames.set(variant, outputName)
      await copyFile(sourceFile, destination, constants.COPYFILE_EXCL)
    }
    stagedNames.add(outputName)
    staged.push(destination)
  }

  return staged
}

async function main() {
  const [platform, sourceDir, outputDir, ...extra] = process.argv.slice(2)
  if (!platform || !sourceDir || !outputDir || extra.length > 0) {
    throw new Error('Usage: stage-release-assets.mjs <linux|windows|macos> <sourceDir> <outputDir>')
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const staged = await stageReleaseAssets({ platform, sourceDir, outputDir, version: manifest.version })
  for (const file of staged) console.log(`[stage-release-assets] ${path.relative(root, file)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[stage-release-assets] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
