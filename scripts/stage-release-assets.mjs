#!/usr/bin/env node

import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/

export const RELEASE_ASSET_DEFINITIONS = Object.freeze({
  linux: Object.freeze([
    Object.freeze({ suffix: '.AppImage', output: (version) => `Maestrly-App-${version}-linux-x64.AppImage` }),
    Object.freeze({ suffix: '.deb', output: (version) => `Maestrly-App-${version}-linux-x64.deb` }),
  ]),
  windows: Object.freeze([
    Object.freeze({ suffix: '.exe', output: (version) => `Maestrly-App-${version}-windows-x64.exe` }),
  ]),
  macos: Object.freeze([
    Object.freeze({ suffix: '.dmg', output: (version) => `Maestrly-App-${version}-macos-arm64.dmg` }),
    Object.freeze({ suffix: '.zip', output: (version) => `Maestrly-App-${version}-macos-arm64.zip` }),
  ]),
})

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
  for (const definition of definitions) {
    const candidates = entries.filter((entry) => entry.name.endsWith(definition.suffix))
    if (candidates.length !== 1) {
      throw new Error(`Expected exactly one ${definition.suffix} release artifact; found ${candidates.length}`)
    }

    const [candidate] = candidates
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      throw new Error(`Release artifact must be a regular file: ${candidate.name}`)
    }
    const sourceFile = path.join(source, candidate.name)
    if ((await stat(sourceFile)).size === 0) throw new Error(`Release artifact is empty: ${candidate.name}`)

    const destination = path.join(output, definition.output(version))
    await copyFile(sourceFile, destination, constants.COPYFILE_EXCL)
    staged.push(destination)
  }

  return staged.sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en'))
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
