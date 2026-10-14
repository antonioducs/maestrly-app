#!/usr/bin/env node
// Runs the desktop Electron E2E suite in a Linux container under Xvfb, like the CI's Linux job, so no window opens and
// nothing takes the focus on this computer. Usage: npm run test:e2e:docker [-- <Playwright arguments>]
//
// Every run copies the working tree as Git sees it (tracked and untracked files, without ignored ones such as
// node_modules and out/) into a new container, then installs, builds, and runs the suite there; later edits do not
// affect a run in progress. Downloads and native build headers are cached in the named volume below. Playwright's
// results are copied back to apps/desktop/test-results. It cannot replace a run on macOS or Windows.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const context = path.join(root, 'apps/desktop/test/docker')
const results = path.join(root, 'apps/desktop/test-results')
const cacheVolume = 'maestrly-desktop-e2e-cache'
const container = 'maestrly-desktop-e2e-' + randomBytes(4).toString('hex')
// Copies the files listed on stdin from the read-only mount, then runs the copy's runner: bash reads a script as it
// goes, so running it from the mount would let an edit made during the run change what runs.
const copyAndRun = [
  'set -euo pipefail',
  'tar -C /src --null --verbatim-files-from --no-recursion --files-from=- -cf - | tar -C /work -xf -',
  'exec bash /work/apps/desktop/test/docker/run-e2e.sh "$@"',
].join('\n')

function fail(message) {
  console.error(`[test:e2e:docker] ${message}`)
  process.exit(1)
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) fail(`${command} is not available: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** Files of the working tree as Git sees it, without the ones deleted but not yet staged. */
function workingTreeFiles(cwd = root) {
  const listed = capture('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return [...new Set(listed.split('\0').filter(Boolean))].filter((file) => {
    try {
      lstatSync(path.join(cwd, file))
      return true
    } catch {
      return false
    }
  })
}

/** A --mount value for a host directory; its CSV quoting keeps commas, colons and drive letters in the path. */
export function bindMount(source, target, readonly = false) {
  return `type=bind,"source=${source.replaceAll('"', '""')}",target=${target}${readonly ? ',readonly' : ''}`
}

/** The image is tagged by its inputs, so a run never builds again what an earlier one built, nor races another. */
export function imageTag(dockerfile, playwrightVersion) {
  const digest = createHash('sha256').update(dockerfile).update('\0').update(playwrightVersion).digest('hex')
  return `maestrly-desktop-e2e:${digest.slice(0, 16)}`
}

function main() {
  const playwrightArgs = process.argv.slice(2)
  capture('docker', ['info', '--format', '{{.ServerVersion}}'])

  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const playwrightVersion = lock.packages?.['node_modules/playwright-core']?.version
  if (!playwrightVersion) fail('package-lock.json has no playwright-core.')
  const image = imageTag(readFileSync(path.join(context, 'Dockerfile')), playwrightVersion)
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    console.log(`[test:e2e:docker] Building ${image}…`)
    const build = spawnSync(
      'docker',
      ['build', '--build-arg', `PLAYWRIGHT_VERSION=${playwrightVersion}`, '--tag', image, context],
      { stdio: 'inherit' }
    )
    if (build.status !== 0) fail('The test image did not build.')
    const earlier = capture('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', 'maestrly-desktop-e2e'])
      .split('\n')
      .filter((tag) => tag && tag !== image)
    if (earlier.length) console.log(`[test:e2e:docker] To remove earlier images: docker image rm ${earlier.join(' ')}`)
  }

  const files = workingTreeFiles()
  rmSync(results, { recursive: true, force: true })
  mkdirSync(results, { recursive: true })
  console.log(`[test:e2e:docker] Running in ${container} with ${files.length} files of ${root}`)
  const started = Date.now()
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--interactive',
      '--init',
      '--name',
      container,
      // Chromium keeps its shared memory in /dev/shm, which Docker limits to 64 MB by default.
      '--shm-size=2g',
      // Docker's default seccomp profile denies the user namespaces Chromium's sandbox needs. Without them Electron
      // falls back to the setuid helper, which npm cannot install, and aborts; the suite keeps the sandbox on.
      '--security-opt',
      'seccomp=unconfined',
      '--mount',
      bindMount(root, '/src', true),
      '--mount',
      bindMount(results, '/results'),
      '--volume',
      `${cacheVolume}:/home/ubuntu/.cache`,
      ...(process.stdout.isTTY ? ['--env', 'FORCE_COLOR=1'] : []),
      image,
      'bash',
      '-c',
      copyAndRun,
      'run-e2e',
      ...playwrightArgs,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  )
  // A container that fails to start closes its input early; its exit code reports that.
  child.stdin.on('error', () => {})
  child.stdin.end(files.join('\0') + '\0')

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    console.error(`\n[test:e2e:docker] Stopping ${container}…`)
    spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  child.on('error', (error) => fail(`docker run failed: ${error.message}`))
  child.on('close', (code) => {
    if (stopping) process.exit(130)
    const minutes = ((Date.now() - started) / 60_000).toFixed(1)
    console.log(`[test:e2e:docker] Finished in ${minutes} min; results in ${path.relative(root, results)}`)
    process.exit(code ?? 1)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
