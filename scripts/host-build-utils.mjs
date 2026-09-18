import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function safeRelative(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(value) ||
    value.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('PATH: expected a safe relative artifact path')
  return value
}
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function verifyInput(root, entry) {
  const relative = safeRelative(entry.path)
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('HASH: SHA256 required')
  let current = await realpath(root)
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('SYMLINK: build inputs must be regular files')
  }
  if (!(await lstat(current)).isFile()) throw new Error('FILE: expected regular file')
  if ((await sha256(current)) !== entry.sha256) throw new Error(`HASH: mismatch for ${relative}`)
  return current
}
export function validateBuildConfig(config) {
  if (
    !config ||
    !['arm64', 'x64'].includes(config.architecture) ||
    !/^22\.(\d+)\.\d+$/.test(config.nodeVersion) ||
    Number(config.nodeVersion.split('.')[1]) < 15 ||
    !/^\d+\.\d+\.\d+$/.test(config.qemuVersion) ||
    !Array.isArray(config.files) ||
    !config.files.length ||
    !path.isAbsolute(config.inputDirectory ?? '')
  )
    throw new Error(
      'CONFIG: explicit architecture, Node 22 >=22.15, QEMU version, inputDirectory and verified files required'
    )
  const seen = new Set()
  for (const entry of config.files) {
    safeRelative(entry.path)
    if (
      seen.has(entry.path) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !entry.license ||
      !/^https:\/\//.test(entry.source ?? '')
    )
      throw new Error('CONFIG: unique files with SHA256, license and source required')
    seen.add(entry.path)
  }
  for (const file of [
    'bin/node',
    'bin/qemu-img',
    `bin/qemu-system-${config.architecture === 'arm64' ? 'aarch64' : 'x86_64'}`,
  ])
    if (!seen.has(file)) throw new Error(`CONFIG: missing ${file}`)
  for (const key of ['firmware', 'firmwareVars'])
    if (config[key] && !seen.has(safeRelative(config[key]))) throw new Error(`CONFIG: missing ${key}`)
  if (config.architecture === 'arm64' && !config.firmware) throw new Error('CONFIG: Arm requires verified firmware')
  /**
   * Local speech recognition is optional, but once the operator names a bundle the rule belongs
   * to the configuration contract rather than to a single writer: a directory outside the Host's
   * own root-owned tree could be writable by an ordinary account, which would turn a "verified"
   * bundle into code chosen by whoever can write there.
   */
  const asrBundleDirectory = config.asrBundleDirectory
  if (
    asrBundleDirectory !== undefined &&
    (typeof asrBundleDirectory !== 'string' || !asrBundleDirectory.startsWith('/Library/MaestrlyHost/'))
  )
    throw new Error('CONFIG: asrBundleDirectory must live under /Library/MaestrlyHost/')
  return config
}
export function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
    shell: false,
  })
  if (result.error || result.status !== 0)
    throw new Error(
      `COMMAND: ${path.basename(file)} failed (${result.status}): ${(result.stderr ?? result.error?.message ?? '').slice(-2000)}`
    )
  return result.stdout.trim()
}

export function minimumMacOS(loadCommands) {
  const values = [...loadCommands.matchAll(/\bminos\s+(\d+(?:\.\d+){0,2})/g)].map((match) => match[1])
  for (const match of loadCommands.matchAll(/LC_VERSION_MIN_MACOSX\s+cmdsize\s+\d+\s+version\s+(\d+(?:\.\d+){0,2})/g))
    values.push(match[1])
  if (!values.length) throw new Error('MACHO: minimum macOS version not present')
  return values.sort((a, b) => compareVersions(a, b)).at(-1)
}
export function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff) return diff
  }
  return 0
}
