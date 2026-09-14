#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, readdir, chmod, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyInput, safeRelative, sha256, run } from './host-build-utils.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function build() {
  const configPath = process.env.MAESTRLY_BOT_BUILD_CONFIG
  if (!configPath)
    throw new Error(
      'BUILD_CONFIG_REQUIRED: set MAESTRLY_BOT_BUILD_CONFIG to the private input manifest; see apps/bot-runtime/README.md'
    )
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (
    config.architecture !== 'arm64' ||
    !/^22\.\d+\.\d+$/.test(config.nodeVersion ?? '') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.version ?? '') ||
    !Array.isArray(config.files)
  )
    throw new Error('INVALID_CONFIG: arm64, version, pinned Node 22 and files required')
  const inputDirectory = config.inputDirectory ?? path.dirname(path.resolve(configPath))
  const seen = new Set()
  const inputs = []
  for (const entry of config.files) {
    safeRelative(entry.path)
    if (
      seen.has(entry.path) ||
      !entry.license ||
      !entry.source ||
      !['runtime/', 'codex/', 'chromium/'].some((prefix) => entry.path.startsWith(prefix))
    )
      throw new Error(
        'INVALID_INPUT: unique runtime, codex or chromium input with license and source required'
      )
    seen.add(entry.path)
    inputs.push({ entry, source: await verifyInput(inputDirectory, entry) })
  }
  for (const required of ['runtime/bin/node', 'codex/bin/codex', 'chromium/chrome'])
    if (!seen.has(required)) throw new Error('MISSING_INPUT: ' + required)
  // Cross builds cannot execute these inputs. Verify ELF machine headers instead.
  for (const required of ['runtime/bin/node', 'codex/bin/codex', 'chromium/chrome']) {
    const input = inputs.find(({ entry }) => entry.path === required)
    const bytes = await readFile(input.source)
    if (
      bytes.length < 20 ||
      bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== 183
    )
      throw new Error('ARCHITECTURE_MISMATCH: expected Linux Arm64 ELF: ' + required)
  }
  const out = path.resolve(
    process.env.MAESTRLY_BOT_BUILD_OUTPUT ?? path.join(root, 'dist/bot-runtime', config.version)
  )
  const staging = path.join(out, 'bundle')
  await mkdir(path.dirname(out), { recursive: true })
  // Refuse to replace any successful or partial prior build.
  await mkdir(out)
  await mkdir(staging)
  try {
    for (const { entry, source } of inputs) {
      const target = path.join(staging, entry.path)
      await mkdir(path.dirname(target), { recursive: true })
      await cp(source, target)
      if (
        [
          'runtime/bin/node',
          'codex/bin/codex',
          'chromium/chrome',
          'chromium/chrome_crashpad_handler',
          'chromium/chrome_sandbox',
        ].includes(entry.path)
      )
        await chmod(target, 0o755)
    }
    const { build: bundle } = await import('esbuild')
    await bundle({
      entryPoints: {
        main: path.join(root, 'apps/bot-runtime/src/main.ts'),
        'vm/main': path.join(root, 'apps/bot-runtime/src/vm/main.ts'),
        'tools/mcp-main': path.join(root, 'apps/bot-runtime/src/tools/mcp-main.ts'),
      },
      outdir: path.join(staging, 'app'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['playwright-core'],
      alias: {
        '@maestrly/codex-client': path.join(root, 'packages/codex-client/src/index.ts'),
        '@maestrly/guest-transport': path.join(root, 'packages/guest-transport/src/index.ts'),
        '@maestrly/host-protocol': path.join(root, 'packages/host-protocol/src/index.ts'),
      },
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
    })
    const require = createRequire(path.join(root, 'apps/bot-runtime/package.json'))
    const playwright = path.dirname(require.resolve('playwright-core/package.json'))
    await cp(playwright, path.join(staging, 'node_modules/playwright-core'), {
      recursive: true,
      dereference: true,
    })
    await cp(path.join(playwright, 'LICENSE'), path.join(staging, 'PLAYWRIGHT_LICENSE'))
    await writeFile(
      path.join(staging, 'package.json'),
      JSON.stringify({ type: 'module', version: config.version })
    )
    await cp(path.join(root, 'deploy/bot-runtime/linux'), path.join(staging, 'install'), {
      recursive: true,
    })
    await cp(path.join(staging, 'install/install.sh'), path.join(staging, 'install.sh'))
    let sessionMeasurement
    if (config.sessionCapacity) {
      const { sessionCapacitySchema } = await import('../packages/host-protocol/dist/index.js')
      const capacity = sessionCapacitySchema.parse(config.sessionCapacity)
      if (!config.sessionEvidence) throw new Error('SESSION_EVIDENCE_REQUIRED')
      const evidence = await verifyInput(inputDirectory, config.sessionEvidence)
      if (await sha256(evidence) !== capacity.evidenceSha256) throw new Error('SESSION_EVIDENCE_MISMATCH')
      const measured = JSON.parse(await readFile(evidence, 'utf8'))
      if (measured.verified !== true || measured.sessions < 2 || measured.network !== 'none' || measured.isolation !== true)
        throw new Error('SESSION_EVIDENCE_INCOMPLETE')
      if (capacity.maxSessions !== measured.sessions || JSON.stringify(capacity.perSession) !== JSON.stringify(measured.capacity?.perSession) ||
          capacity.systemMemoryMiB !== measured.capacity?.systemMemoryMiB || capacity.systemDiskMiB !== measured.capacity?.systemDiskMiB)
        throw new Error('SESSION_PROFILE_NOT_MEASURED')
      sessionMeasurement = measured
      await writeFile(path.join(staging, 'session-capacity.json'), JSON.stringify(capacity, null, 2) + '\n')
    }
    if (config.offlineDependencies) {
      const addon = await verifyInput(inputDirectory, config.offlineDependencies)
      const entries = run('tar', ['-tf', addon]).trim().split('\n')
      if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..')))
        throw new Error('UNSAFE_DEPENDENCY_ARCHIVE')
      await mkdir(path.join(staging, 'offline-dependencies'))
      run('tar', ['-xf', addon, '-C', path.join(staging, 'offline-dependencies')])
    }
    const files = []
    async function collect(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative + '/')
        else if (entry.isFile()) {
          const provenance = config.files.find((file) => file.path === relative)
          files.push({
            path: relative,
            sha256: await sha256(path.join(directory, entry.name)),
            ...(provenance ? { license: provenance.license, source: provenance.source } : {}),
          })
        } else throw new Error('NON_REGULAR_BUNDLE_FILE')
      }
    }
    await collect(staging)
    const tar = path.join(out, 'maestrly-bot-runtime-' + config.version + '-arm64.tar')
    // Linux guests do not consume macOS resource forks or provenance xattrs.
    run(
      'tar',
      [
        ...(process.platform === 'darwin' ? ['--no-mac-metadata'] : []),
        '--no-xattrs',
        '-cf',
        tar,
        '-C',
        staging,
        '.',
      ],
      {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      }
    )
    const capabilities = [
      'account.delegation.v1',
      ...(config.sessionCapacity ? ['bot.sessions.v1'] : []),
      'provider.codex',
      'tools.files',
      'network.proxy',
      'network.blocklist.v1',
      'tools.browser',
      'tools.computer',
      'tools.system',
      'tools.memory',
      'desktop.session',
    ]
    await writeFile(
      tar + '.manifest.json',
      JSON.stringify(
        {
          version: 1,
          runtimeVersion: config.version,
          id: 'maestrly-bot-runtime-' + config.version + '-arm64',
          architecture: 'arm64',
          sha256: await sha256(tar),
          files,
          requirementsEvidence: sessionMeasurement ? {
            kind: 'measured-local-profile', measured: true, evidenceSha256: config.sessionCapacity.evidenceSha256,
            scope: 'Two unprivileged graphical sessions, input, capture, isolation and recovery; authenticated model workload requires separate qualification',
          } : {
            kind: 'estimate',
            measured: false,
            note: 'Planning estimates only; Ubuntu GUI and workload qualification pending',
          },
          sourceArchives: config.archives ?? [],
          requirements: sessionMeasurement ? {
            minimum: sessionMeasurement.resources,
            recommended: sessionMeasurement.resources,
          } : {
            minimum: { cpus: 2, memoryMiB: 3072, diskGiB: 16 },
            recommended: { cpus: 2, memoryMiB: 4096, diskGiB: 24 },
          },
          capabilities,
          ...(config.sessionCapacity ? { sessions: config.sessionCapacity } : {}),
          qualification: 'built-on-controller-not-qualified-on-target',
        },
        null,
        2
      ) + '\n'
    )
    await cp(path.join(staging, 'app'), path.join(out, 'app'), {
      recursive: true,
    })
    console.log(tar)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
build().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
