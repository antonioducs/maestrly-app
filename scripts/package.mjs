#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = path.join(root, 'apps', 'desktop')
const [channel, ...builderArgs] = process.argv.slice(2)

const CHANNELS = new Set(['prod', 'beta', 'dev'])
if (!CHANNELS.has(channel)) {
  console.error(`package: invalid channel "${channel}". Use: ${[...CHANNELS].join(' | ')}`)
  process.exit(1)
}

const env = { ...process.env, MAIN_VITE_CHANNEL: channel }

class CommandFailure extends Error {
  constructor(status) {
    super(`command failed with status ${status}`)
    this.status = status
  }
}

function run(cmd, args, cwd = root) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd, env, shell: false })
  if (result.error) {
    throw new Error(`[package] failed to invoke ${cmd}: ${result.error.message}`)
  }
  if (result.status !== 0) throw new CommandFailure(result.status ?? 1)
}

function runPackageBin(packageName, bin, args, cwd = root) {
  const packageFile = path.join(root, 'node_modules', packageName, bin)
  run(process.execPath, [packageFile, ...args], cwd)
}

function nativeRuntimeTargets(args) {
  const osFlags = [
    ['--mac', 'mac'],
    ['--linux', 'linux'],
    ['--win', 'win'],
  ]
  const archFlags = [
    ['--arm64', 'arm64'],
    ['--x64', 'x64'],
  ]
  const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
  const oses = osFlags.filter(([flag]) => args.includes(flag)).map(([, os]) => os)
  const arches = archFlags.filter(([flag]) => args.includes(flag)).map(([, arch]) => arch)
  const selectedOses = oses.length > 0 ? oses : [hostOs]
  const selectedArches = arches.length > 0 ? arches : [process.arch]
  return [...new Set(selectedOses.flatMap((os) => selectedArches.map((arch) => `${os}-${arch}`)))]
}

const runtimeTargets = nativeRuntimeTargets(builderArgs)
if (runtimeTargets.length !== 1) {
  console.error(
    `[package] package a single OS/architecture per invocation; received: ${runtimeTargets.join(', ')}. ` +
      'Optional native packages are exclusive to each artifact.'
  )
  process.exit(1)
}

if (!builderArgs.some((arg) => arg === '--config' || arg.startsWith('--config='))) {
  builderArgs.push('--config', channel === 'prod' ? 'electron-builder.yml' : `electron-builder.${channel}.yml`)
}
builderArgs.push('--publish', 'never')

const runtimeFetchArgs = runtimeTargets.flatMap((target) => ['--target', target])
const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform
const hostTarget = `${hostOs}-${process.arch}`
let failure = null

try {
  run(process.execPath, ['scripts/build-local-ml-runtime.mjs', ...runtimeFetchArgs])
  const manifest = JSON.parse(readFileSync(path.join(desktopRoot, 'runtime-assets/local-ml/manifest.json'), 'utf8'))
  const archive = `local-ml-runtime-${manifest.version}-${runtimeTargets[0]}.tar.gz`
  const archivePath = path.join(desktopRoot, 'runtime-assets/local-ml/archives', archive)
  if (runtimeTargets[0] === hostTarget) {
    run(process.execPath, ['scripts/smoke-local-ml-runtime.mjs', archivePath])
  } else {
    run(process.execPath, ['scripts/verify-cross-local-ml-runtime.mjs', archivePath, '--target', runtimeTargets[0]])
  }
  const bundle = path.join(desktopRoot, 'runtime-assets/local-ml/bundle')
  rmSync(bundle, { recursive: true, force: true })
  mkdirSync(bundle, { recursive: true })
  copyFileSync(archivePath, path.join(bundle, archive))

  runPackageBin('electron-vite', 'bin/electron-vite.js', ['build'], desktopRoot)
  runPackageBin('electron-builder', 'cli.js', builderArgs, desktopRoot)

  const platform = builderArgs.includes('--mac')
    ? 'mac'
    : builderArgs.includes('--win')
      ? 'win'
      : builderArgs.includes('--linux')
        ? 'linux'
        : null
  const requiredArtifacts =
    platform === 'win'
      ? ['exe']
      : platform === 'linux'
        ? ['appimage', 'deb']
        : platform === 'mac'
          ? ['dmg', 'zip'].filter((format) => builderArgs.includes(format))
          : []
  run(process.execPath, [
    'scripts/verify-packaged-sounds.mjs',
    path.join(desktopRoot, 'dist'),
    ...(platform ? [`--platform=${platform}`] : []),
    ...requiredArtifacts.map((format) => `--require-artifact=${format}`),
  ])
  const arch = builderArgs.includes('--arm64')
    ? 'arm64'
    : builderArgs.includes('--x64')
      ? 'x64'
      : process.arch === 'arm64'
        ? 'arm64'
        : 'x64'
  const reportFile = path.join(desktopRoot, 'dist', `bundle-size-${platform ?? process.platform}-${arch}.json`)
  run(process.execPath, ['scripts/report-bundle-size.mjs', path.join(desktopRoot, 'dist'), `--arch=${arch}`, `--json=${reportFile}`])
  run(process.execPath, ['scripts/check-bundle-size.mjs', `--report=${reportFile}`])
} catch (error) {
  failure = error
}

if (failure instanceof CommandFailure) process.exit(failure.status)
if (failure) throw failure
