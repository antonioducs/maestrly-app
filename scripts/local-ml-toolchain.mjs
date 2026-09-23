#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Local ML archive hashes are pinned in apps/desktop/runtime-assets/local-ml/manifest.json, and the build
 * rewrites that tracked file with the hash it produces. The tar payload is deterministic, but gzip output depends
 * on the zlib implementation that compresses it. Official Node.js binaries (nodejs.org, nvm, fnm, and
 * actions/setup-node in CI) bundle their own zlib; distribution builds such as Homebrew's `node` link the system
 * zlib instead and produce different archive bytes. Refuse those before any build work so the pins stay reproducible.
 */
export function sharedZlibProblem({
  config = process.config,
  versions = process.versions,
  execPath = process.execPath,
} = {}) {
  const shared = config?.variables?.node_shared_zlib
  if (shared !== true && shared !== 'true') return null
  return (
    `Node.js at ${execPath} links a shared system zlib (${versions?.zlib ?? 'unknown version'}), so it cannot ` +
    'reproduce the Local ML archive hashes pinned in apps/desktop/runtime-assets/local-ml/manifest.json. ' +
    'Use an official Node.js build that matches .nvmrc (nodejs.org installer, nvm, or fnm) first on PATH and run ' +
    'the command again. Distribution builds such as Homebrew node use the system zlib.'
  )
}

export function assertBundledZlib(options) {
  const problem = sharedZlibProblem(options)
  if (problem) throw new Error(problem)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problem = sharedZlibProblem()
  if (problem) {
    console.error(`[local-ml-toolchain] ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`[local-ml-toolchain] ok: ${process.execPath} bundles zlib ${process.versions.zlib}`)
  }
}
