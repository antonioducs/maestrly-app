import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
const cwd = fileURLToPath(new URL('../apps/bot-desktop/', import.meta.url))
const require = createRequire(join(cwd, 'package.json'))
if (process.argv.length > 2) throw new Error('Lab packaging accepts no publishing or configuration overrides.')
const run = (args, extraEnv = {}) => {
  const result = spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...extraEnv },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['run', 'build'])
run(['exec', '--', 'electron-builder', '--config', 'electron-builder.yml', '--dir', '--publish', 'never'])
const output = join(cwd, 'dist/lab')
const platformDir =
  process.platform === 'darwin'
    ? `mac${process.arch === 'arm64' ? '-arm64' : ''}`
    : process.platform === 'win32'
      ? 'win-unpacked'
      : 'linux-unpacked'
const bundle = join(output, platformDir, ...(process.platform === 'darwin' ? ['Maestrly Bot Lab.app', 'Contents'] : []))
const asar = join(bundle, process.platform === 'darwin' ? 'Resources' : 'resources', 'app.asar')
const executable = join(
  bundle,
  ...(process.platform === 'darwin'
    ? ['MacOS', 'Maestrly Bot Lab']
    : [process.platform === 'win32' ? 'Maestrly Bot Lab.exe' : 'maestrly-bot-desktop'])
)
const report = join(output, '.startup-verification.json')
await unlink(report).catch((error) => {
  if (error.code !== 'ENOENT') throw error
})
run(['exec', '--', 'playwright', 'test', 'test/e2e/host-management.spec.ts'], {
  BOT_PACKAGED_EXECUTABLE: executable,
  BOT_PACKAGED_REPORT: report,
})
const verification = JSON.parse(await readFile(report, 'utf8'))
const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
const inventory = {
  appId: 'io.github.antonioducs.maestrly.bot',
  appVersion: manifest.version,
  platform: process.platform,
  architecture: process.arch,
  electronVersion: require('electron/package.json').version,
  executable: relative(output, executable).split('\\').join('/'),
  asar: {
    path: relative(output, asar).split('\\').join('/'),
    sha256: createHash('sha256')
      .update(await readFile(asar))
      .digest('hex'),
  },
  verification,
  published: false,
}
await writeFile(join(output, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
await unlink(report)
console.log('Local package inventory written to dist/lab/inventory.json; startup and sandbox verified.')
