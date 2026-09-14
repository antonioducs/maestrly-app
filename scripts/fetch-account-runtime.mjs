#!/usr/bin/env node
import { mkdir, writeFile, readFile, chmod, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { run, safeRelative, sha256 } from './host-build-utils.mjs'
export const ACCOUNT_CODEX_VERSION = '0.153.4'
export const accountPins = {
  arm64: { triple: 'aarch64-apple-darwin', integrity: 'B1qhN3fa1ay0R0wGziXqgwSkB5icpYChNKHhtBHff/0UtSTC7z+l8aTtvMlGjH3E8HEvY3+njIJelM9CAAoVWg==' },
  x64: { triple: 'x86_64-apple-darwin', integrity: 'vnSbbPzfoDZmmyzsxswsDDXQ06IVFBzkQU7/hroB3ji93Ok2utcsq8Psfk2tjF5r9mEx8RWFJhzuTGHG26/NDA==' },
}
export async function fetchAccountRuntime(destination, arch = process.arch) {
  const pin = accountPins[arch]
  if (!pin) throw new Error('ACCOUNT_ARCH_UNSUPPORTED')
  const reference = await readFile(new URL('./fetch-codex-runtime.mjs', import.meta.url), 'utf8')
  if (!reference.includes(`CODEX_RUNTIME_VERSION = '${ACCOUNT_CODEX_VERSION}'`) || !reference.includes(pin.integrity)) throw new Error('ACCOUNT_CODEX_PIN_MISMATCH')
  destination = path.resolve(destination)
  await mkdir(destination, { mode: 0o700 })
  const url = `https://registry.npmjs.org/@openai/codex/-/codex-${ACCOUNT_CODEX_VERSION}-darwin-${arch}.tgz`
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error('ACCOUNT_CODEX_DOWNLOAD_FAILED')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha512').update(bytes).digest('base64') !== pin.integrity) throw new Error('ACCOUNT_CODEX_HASH_MISMATCH')
  const archive = path.join(destination, 'codex.tgz')
  await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
  const member = `package/vendor/${pin.triple}/bin/codex`
  const entries = run('/usr/bin/tar', ['-tf', archive]).split('\n')
  for (const entry of entries) safeRelative(entry.replace(/\/$/, ''))
  if (!entries.includes(member)) throw new Error('ACCOUNT_CODEX_BINARY_MISSING')
  await mkdir(path.join(destination, 'extracted'))
  run('/usr/bin/tar', ['-xf', archive, '-C', path.join(destination, 'extracted'), member])
  const binary = path.join(destination, 'codex')
  await cp(path.join(destination, 'extracted', member), binary, { force: false, errorOnExist: true })
  await chmod(binary, 0o755)
  await cp(new URL('../apps/desktop/resources/licenses/openai-codex-runtime-apache-2.0.txt', import.meta.url), path.join(destination, 'LICENSE'))
  await cp(new URL('../apps/desktop/resources/licenses/openai-codex-runtime-NOTICE.txt', import.meta.url), path.join(destination, 'NOTICE'))
  await mkdir(path.join(destination, 'probe-home'), { mode: 0o700 })
  if (process.platform === 'darwin' && process.arch === arch) {
    const version = run(binary, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: path.join(destination, 'probe-home'), CODEX_HOME: path.join(destination, 'probe-home/codex') } })
    if (version !== `codex-cli ${ACCOUNT_CODEX_VERSION}`) throw new Error('ACCOUNT_CODEX_VERSION_MISMATCH')
  }
  const manifest = { version: ACCOUNT_CODEX_VERSION, architecture: arch, binary: { path: binary, sha256: await sha256(binary) }, source: url, archiveSha512: pin.integrity, license: 'Apache-2.0' }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(manifest))
  return manifest
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: fetch-account-runtime.mjs <new-output-directory> [arm64|x64]')
  await fetchAccountRuntime(process.argv[2], process.argv[3])
}
