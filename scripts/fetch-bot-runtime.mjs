#!/usr/bin/env node
// Offline builds consume the manifest produced here; no floating release selectors.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, cp, lstat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, sha256, safeRelative } from './host-build-utils.mjs'

export const pins = {
  node: { version: '22.23.2', url: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz', sha256: 'fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8', verification: 'Node official SHASUMS256.txt over HTTPS; signature not verified' },
  codex: { version: '0.153.4', url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.153.4-linux-arm64.tgz', sha512: 'QKdjYLYV4hXIuUQDP3P6F4NXuWFoKo9WUoV4nAREIx55kiUyi8UsYdsVobkeXir5n/maEQgYMCKLHVma4rNPiw==', verification: 'SHA512 pinned by scripts/fetch-codex-runtime.mjs' },
  chromium: { playwright: '1.62.1', revision: '1234', version: '151.0.7922.34', url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-linux-arm64.zip', sha256: 'b5ad7d8fe70f230b34198ddb5626d717c016db2f627cb44b922babbcaf3479b9', verification: 'SHA256 observed from official Playwright CDN over HTTPS on 2026-09-13; no independently published checksum' },
}

export async function fetchRuntime(destination, version = '0.1.0') {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version)) throw new Error('INVALID_VERSION')
  const require = createRequire(new URL('../apps/bot-runtime/package.json', import.meta.url))
  const playwrightPath = require.resolve('playwright-core/package.json')
  const playwright = JSON.parse(await readFile(playwrightPath, 'utf8'))
  const browsers = JSON.parse(await readFile(path.join(path.dirname(playwrightPath), 'browsers.json'), 'utf8'))
  if (playwright.version !== pins.chromium.playwright || browsers.browsers.find(b => b.name === 'chromium')?.revision !== pins.chromium.revision) throw new Error('PLAYWRIGHT_PIN_MISMATCH')
  const desktop = await readFile(new URL('./fetch-codex-runtime.mjs', import.meta.url), 'utf8')
  if (!desktop.includes(`CODEX_RUNTIME_VERSION = '${pins.codex.version}'`) || !desktop.includes(pins.codex.sha512)) throw new Error('CODEX_PIN_MISMATCH')
  destination = path.resolve(destination)
  // Exclusive directory creation preserves all previous inputs, including failed runs.
  await mkdir(destination)
  const files = []
  const archives = []
  async function copyTree(source, relative, pin, license) {
    const stat = await lstat(source)
    if (stat.isDirectory()) {
      for (const name of (await readdir(source)).sort()) await copyTree(path.join(source, name), `${relative}/${name}`, pin, license)
    } else {
      safeRelative(relative)
      if (!stat.isFile()) throw new Error('NON_REGULAR_SOURCE: ' + relative)
      const target = path.join(destination, 'inputs', relative)
      await mkdir(path.dirname(target), { recursive: true })
      await cp(source, target, { errorOnExist: true, force: false })
      files.push({ path: relative, sha256: await sha256(target), source: pin.url, license })
    }
  }
  for (const [name, pin] of Object.entries(pins)) {
    const archive = path.join(destination, name + (name === 'chromium' ? '.zip' : '.tar'))
    console.log('Downloading ' + pin.url)
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error('DOWNLOAD_FAILED: ' + name)
    await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }))
    const hash = await sha256(archive)
    if (pin.sha256 && hash !== pin.sha256) throw new Error('HASH_MISMATCH: ' + name)
    if (pin.sha512 && createHash('sha512').update(await readFile(archive)).digest('base64') !== pin.sha512) throw new Error('HASH_MISMATCH: ' + name)
    archives.push({ name, ...pin, sha256: hash, resolvedUrl: response.url })
    const extraction = path.join(destination, name + '-extracted')
    await mkdir(extraction)
    if (name === 'chromium') {
      for (const entry of run('unzip', ['-Z1', archive]).split('\n')) safeRelative(entry.replace(/\/$/, ''))
      run('unzip', ['-q', archive, '-d', extraction])
      await copyTree(path.join(extraction, 'chrome-linux'), 'chromium', pin, 'BSD-3-Clause and bundled third-party licenses (ABOUT/credits.html)')
    } else if (name === 'node') {
      // Extract only named regular members; npm symlinks and headers are unnecessary.
      run('tar', ['-xf', archive, '-C', extraction, `node-v${pin.version}-linux-arm64/bin/node`, `node-v${pin.version}-linux-arm64/LICENSE`])
      await copyTree(path.join(extraction, `node-v${pin.version}-linux-arm64/bin/node`), 'runtime/bin/node', pin, 'MIT and bundled third-party licenses')
      await copyTree(path.join(extraction, `node-v${pin.version}-linux-arm64/LICENSE`), 'runtime/LICENSE', pin, 'MIT and bundled third-party licenses')
    } else {
      const vendor = 'package/vendor/aarch64-unknown-linux-musl'
      for (const entry of run('tar', ['-tf', archive]).split('\n')) safeRelative(entry.replace(/\/$/, ''))
      run('tar', ['-xf', archive, '-C', extraction, vendor])
      await copyTree(path.join(extraction, vendor), 'codex', pin, 'Apache-2.0')
      await copyTree(fileURLToPath(new URL('../apps/desktop/resources/licenses/openai-codex-runtime-apache-2.0.txt', import.meta.url)), 'codex/LICENSE', pin, 'Apache-2.0')
      await copyTree(fileURLToPath(new URL('../apps/desktop/resources/licenses/openai-codex-runtime-NOTICE.txt', import.meta.url)), 'codex/NOTICE', pin, 'Apache-2.0')
    }
  }
  const manifest = path.join(destination, 'build-config.json')
  await writeFile(manifest, JSON.stringify({ architecture: 'arm64', version, nodeVersion: pins.node.version, inputDirectory: path.join(destination, 'inputs'), archives, files }, null, 2) + '\n', { flag: 'wx' })
  console.log(manifest)
  return manifest
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/fetch-bot-runtime.mjs <new-output-directory> [bundle-version]')
  fetchRuntime(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
