import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
export function assertPackageCompatibility(manifest, facts) {
  if (facts.platform !== 'darwin') throw new Error('PACKAGE_PLATFORM: macOS required')
  if (!['arm64', 'x64'].includes(manifest.architecture) || manifest.architecture !== facts.arch || facts.arch !== facts.physicalArch) throw new Error('PACKAGE_ARCHITECTURE: native package matching the physical Host required')
  if (!/^\d+(?:\.\d+){0,2}$/.test(manifest.minimumMacOS ?? '') || !/^\d+(?:\.\d+){0,2}$/.test(facts.macOS ?? '')) throw new Error('PACKAGE_COMPATIBILITY: measured macOS versions required')
  const minimum = manifest.minimumMacOS.split('.').map(Number)
  const actual = facts.macOS.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const delta = (actual[index] ?? 0) - (minimum[index] ?? 0)
    if (delta < 0) throw new Error(`PACKAGE_MACOS: this artifact requires macOS ${manifest.minimumMacOS}`)
    if (delta > 0) break
  }
  if (manifest.nodeVersion !== facts.nodeVersion) throw new Error('PACKAGE_NODE: bundled Node version mismatch')
}
async function main() {
  if (process.argv.length !== 3) throw new Error('Expected the verified package manifest')
  const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'))
  let physicalArch = process.arch
  if (process.platform === 'darwin') {
    let arm = ''
    try { arm = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() } catch { /* Older Intel kernels may omit this key. */ }
    const machine = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.machine'], {encoding:'utf8'}).trim()
    physicalArch = arm === '1' ? 'arm64' : machine === 'x86_64' ? 'x64' : 'unverified'
  }
  assertPackageCompatibility(manifest, { platform: process.platform, arch: process.arch, physicalArch, macOS: process.platform === 'darwin' ? execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : '', nodeVersion: process.versions.node })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
