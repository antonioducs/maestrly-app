#!/usr/bin/env node
import { ACCOUNT_CODEX_VERSION } from './fetch-account-runtime.mjs'
// Package an explicitly supplied, relocatable, pinned macOS QEMU runtime.
// This build process is intentionally independent of HostService / VM lifecycle.
import { cp, mkdir, readFile, writeFile, chmod, rename, rm, lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { validateBuildConfig, verifyInput, sha256, run, minimumMacOS, compareVersions } from './host-build-utils.mjs'
import { bundleHostSource } from './host-source-bundle.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function build() {
  const configPath = process.env.MAESTRLY_HOST_BUILD_CONFIG
  if (!configPath)
    throw new Error(
      'BUILD_CONFIG_REQUIRED: set MAESTRLY_HOST_BUILD_CONFIG to the private runtime input manifest; see docs/maestrly-host.md'
    )
  const config = validateBuildConfig(JSON.parse(await readFile(configPath, 'utf8')))
  if (process.platform !== 'darwin' || process.arch !== config.architecture)
    throw new Error('BUILD_ARCH: package on a native macOS machine matching the selected Host architecture')
  const out = path.resolve(process.env.MAESTRLY_HOST_BUILD_OUTPUT ?? path.join(root, 'dist', `maestrly-host-${config.architecture}`))
  try {
    await lstat(out)
    throw new Error('OUTPUT_EXISTS: retain the existing package; move it before rebuilding')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(out), { recursive: true })
  const staging = `${out}.staging-${randomUUID()}`
  await mkdir(staging, { mode: 0o700 })
  try {
    for (const entry of config.files) {
      const source = await verifyInput(config.inputDirectory, entry)
      const target = path.join(staging, 'runtime', entry.path)
      await mkdir(path.dirname(target), { recursive: true })
      await cp(source, target)
      await chmod(target, entry.path.startsWith('bin/') ? 0o755 : 0o644)
    }
    const bin = path.join(staging, 'runtime/bin')
    const node = path.join(bin, 'node')
    if (run(node, ['--version']) !== `v${config.nodeVersion}`) throw new Error('NODE_VERSION_MISMATCH')
    const qemu = path.join(bin, `qemu-system-${config.architecture === 'arm64' ? 'aarch64' : 'x86_64'}`)
    if (!run(qemu, ['--version']).includes(`version ${config.qemuVersion}`)) throw new Error('QEMU_VERSION_MISMATCH')
    if (!run(path.join(bin, 'qemu-img'), ['--version']).includes(`version ${config.qemuVersion}`))
      throw new Error('QEMU_IMG_VERSION_MISMATCH')
    if (run(node, ['-p', 'process.arch']) !== config.architecture) throw new Error('NODE_ARCHITECTURE_MISMATCH')
    const measuredOSVersions = []
    // Refuse incidental Homebrew or build-machine dylibs, including transitive inputs.
    for (const entry of config.files.filter((f) => f.path.startsWith('bin/') || f.path.endsWith('.dylib'))) {
      const target = path.join(staging, 'runtime', entry.path)
      const arches = run('/usr/bin/lipo', ['-archs', target]).split(/\s+/)
      if (!arches.includes(config.architecture === 'arm64' ? 'arm64' : 'x86_64'))
        throw new Error(`MACHO_ARCHITECTURE_MISMATCH: ${entry.path}`)
      measuredOSVersions.push(minimumMacOS(run('/usr/bin/otool', ['-l', target])))
      const deps = run('/usr/bin/otool', ['-L', target])
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(' (')[0])
      for (const dep of deps) {
        if (dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/')) continue
        if (!dep.startsWith('@loader_path/')) throw new Error(`NON_RELOCATABLE: ${entry.path}: ${dep}`)
        const resolved = path.resolve(path.dirname(target), dep.slice('@loader_path/'.length))
        const rel = path.relative(path.join(staging, 'runtime'), resolved)
        if (rel.startsWith('..') || !config.files.some((f) => f.path === rel))
          throw new Error(`UNDECLARED_DYLIB: ${dep}`)
      }
    }
    let measuredMinimumMacOS = measuredOSVersions.sort(compareVersions).at(-1)
    if (compareVersions(run('/usr/bin/sw_vers', ['-productVersion']), measuredMinimumMacOS) < 0)
      throw new Error('MACOS_RUNTIME_INCOMPATIBLE')
    const entitlements = path.join(staging, 'hvf.entitlements.plist')
    await writeFile(
      entitlements,
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>\n'
    )
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', entitlements, qemu])
    run('/usr/bin/codesign', ['--verify', '--strict', qemu])
    const entitlementOutput = run('/usr/bin/codesign', ['--display', '--entitlements', ':-', qemu])
    if (!entitlementOutput.includes('com.apple.security.hypervisor')) throw new Error('HVF_ENTITLEMENT_MISSING')
    // esbuild bundles pure JS dependencies; Node itself is supplied in runtime/bin.
    await bundleHostSource(root, 'apps/host/src/cli.ts', {
      outfile: path.join(staging, 'app/cli.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      packages: 'bundle',
    })
    await bundleHostSource(root, 'packages/host-core/src/index.ts', {
      outfile: path.join(staging, 'app/host-core.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      packages: 'bundle',
    })
    await mkdir(path.join(staging, 'bin'))
    await writeFile(
      path.join(staging, 'bin/maestrly-host'),
      '#!/bin/sh\nset -eu\nMAESTRLY_HOST_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$MAESTRLY_HOST_ROOT/runtime/bin/node" "$MAESTRLY_HOST_ROOT/app/cli.mjs" "$@"\n',
      { mode: 0o755 }
    )
    await cp(path.join(root, 'deploy/host/macos'), path.join(staging, 'install'), { recursive: true })
    const helper = path.join(staging, 'bin/hvf-smoke')
    run('/usr/bin/xcrun', [
      'clang',
      '-O2',
      '-framework',
      'Hypervisor',
      `-mmacosx-version-min=${measuredMinimumMacOS}`,
      path.join(root, 'deploy/host/macos/hvf-smoke.c'),
      '-o',
      helper,
    ])
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', entitlements, helper])
    run('/usr/bin/codesign', ['--verify', '--strict', helper])
    measuredMinimumMacOS = [measuredMinimumMacOS, minimumMacOS(run('/usr/bin/otool', ['-l', helper]))]
      .sort(compareVersions)
      .at(-1)
    await mkdir(path.join(staging, 'etc'))
    const installedRoot = '/Library/MaestrlyHost/runtime'
    const asset = async (relative) => ({
      path: `${installedRoot}/${relative}`,
      sha256: await sha256(path.join(staging, 'runtime', relative)),
    })
    const runtime = {
      id: `qemu-${config.qemuVersion}-${config.architecture}`,
      arch: config.architecture,
      minimumMacOS: measuredMinimumMacOS,
      qemu: await asset(`bin/qemu-system-${config.architecture === 'arm64' ? 'aarch64' : 'x86_64'}`),
      qemuImg: await asset('bin/qemu-img'),
      ...(config.firmware ? { firmware: await asset(config.firmware) } : {}),
      ...(config.firmwareVars ? { firmwareVars: await asset(config.firmwareVars) } : {}),
    }
    const images = []
    for (const entry of config.images ?? []) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.id) ||
        entry.architecture !== config.architecture ||
        !['qcow2', 'raw'].includes(entry.format) ||
        !Number.isSafeInteger(entry.virtualSizeGiB) ||
        entry.virtualSizeGiB < 1 ||
        !config.files.some((file) => file.path === entry.file)
      )
        throw new Error('IMAGE_CONFIG: declared verified image matching runtime required')
      images.push({
        id: entry.id,
        name: entry.name || entry.id,
        arch: entry.architecture,
        asset: await asset(entry.file),
        format: entry.format,
        virtualSizeGiB: entry.virtualSizeGiB,
        guestAgent: true,
      })
    }
    // Phase 2: bot-ready templates pair an image with the verified Linux runtime bundle and its
    // measured requirements (from the bundle manifest). Nothing is inferred or downloaded.
    const templates = []
    for (const entry of config.botTemplates ?? []) {
      const bundleEntry = config.files.find((file) => file.path === entry.bundle)
      const manifestEntry = config.files.find((file) => file.path === entry.bundleManifest)
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.id) ||
        !images.some((image) => image.id === entry.imageId) ||
        !bundleEntry ||
        !manifestEntry ||
        !/^bot\//.test(entry.bundle)
      )
        throw new Error('BOT_TEMPLATE_CONFIG: id, existing imageId, verified bot/ bundle and bundle manifest required')
      const bundleManifest = JSON.parse(await readFile(path.join(staging, 'runtime', entry.bundleManifest), 'utf8'))
      if (bundleManifest.version !== 1 || bundleManifest.architecture !== config.architecture || !bundleManifest.requirements?.minimum || !bundleManifest.requirements?.recommended)
        throw new Error('BOT_TEMPLATE_MANIFEST: bundle manifest with measured requirements for this architecture required')
      if (typeof bundleManifest.runtimeVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bundleManifest.runtimeVersion))
        throw new Error('BOT_TEMPLATE_VERSION: explicit runtime version required')
      const bundleAsset = await asset(entry.bundle)
      if (bundleAsset.sha256 !== bundleManifest.sha256) throw new Error('BOT_TEMPLATE_DIGEST: bundle digest differs from its manifest')
      templates.push({
        id: entry.id,
        imageId: entry.imageId,
        runtimeId: runtime.id,
        arch: config.architecture,
        runtimeIncluded: entry.runtimeIncluded === true,
        runtimeBundle: { ...bundleAsset, version: bundleManifest.runtimeVersion },
        minimum: bundleManifest.requirements.minimum,
        recommended: bundleManifest.requirements.recommended,
        capabilities: Array.isArray(bundleManifest.capabilities) ? bundleManifest.capabilities : [],
      })
    }
    let accounts
    if (config.accounts) {
      if (config.accounts.version !== ACCOUNT_CODEX_VERSION || config.accounts.binary !== 'bin/codex-accounts' || !config.files.some(file => file.path === config.accounts.binary))
        throw new Error('ACCOUNT_RUNTIME_CONFIG: pinned account runtime binary and version required')
      const accountBinary = path.join(staging, 'runtime', config.accounts.binary)
      const probeHome = path.join(staging, 'account-probe-home')
      await mkdir(probeHome, { mode: 0o700 })
      const version = run(accountBinary, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: probeHome, CODEX_HOME: path.join(probeHome, 'codex') } })
      await rm(probeHome, { recursive: true })
      if (version !== `codex-cli ${ACCOUNT_CODEX_VERSION}`) throw new Error('ACCOUNT_RUNTIME_VERSION_MISMATCH')
      const port = config.accounts.peerPort ?? 44953
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ACCOUNT_PEER_PORT_INVALID')
      accounts = { runtime: { version: ACCOUNT_CODEX_VERSION, binary: await asset(config.accounts.binary) }, peers: { host: config.accounts.peerBindAddress ?? '0.0.0.0', port } }
    }
    await writeFile(
      path.join(staging, 'etc/host.json'),
      JSON.stringify({ stateDirectory: '/Library/MaestrlyHost/state', runtimes: [runtime], images, templates, ...(accounts ? { accounts } : {}) }, null, 2)
    )

    await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(staging, 'THIRD_PARTY_NOTICES.md'))
    const files = []
    async function collect(dir, prefix = '') {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (entry.isDirectory()) await collect(path.join(dir, entry.name), `${relative}/`)
        else if (entry.isFile()) files.push({ path: relative, sha256: await sha256(path.join(dir, entry.name)) })
        else throw new Error('PACKAGE_NON_REGULAR_FILE')
      }
    }
    await collect(staging)
    const hostManifest = JSON.parse(await readFile(path.join(root, 'apps/host/package.json'), 'utf8'))
    const manifest = {
      version: 1,
      serviceVersion: hostManifest.version,
      hostSchemaVersion: 4,
      architecture: config.architecture,
      nodeVersion: config.nodeVersion,
      qemuVersion: config.qemuVersion,
      minimumMacOS: measuredMinimumMacOS,
      qualification: 'unqualified',
      builtAt: new Date().toISOString(),
      firmware: config.firmware,
      firmwareVars: config.firmwareVars,
      sources: config.files,
      files,
    }
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(staging, out)
    console.log(
      `Host package: ${out}\nManifest SHA256: ${await sha256(path.join(out, 'manifest.json'))}\nHardware qualification remains required.`
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
build().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
