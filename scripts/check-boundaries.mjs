#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? files(target) : /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [target] : []
  })
}

for (const scope of ['apps/server/src', 'apps/runner/src', 'apps/web/src', 'packages/protocol/src', 'packages/client-sdk/src', 'packages/runner-core/src']) {
  for (const file of files(path.join(root, scope))) {
    const source = readFileSync(file, 'utf8')
    if (/(?:from\s*|import\s*\()['"]electron/.test(source)) failures.push(`${path.relative(root, file)} imports Electron`)
    if (/(?:from\s*|import\s*\()['"][^'"]*apps\/desktop/.test(source)) failures.push(`${path.relative(root, file)} imports desktop code`)
  }
}

for (const file of files(path.join(root, 'packages/protocol/src'))) {
  if (/(?:from\s*|import\s*\()['"]node:/.test(readFileSync(file, 'utf8'))) failures.push(`${path.relative(root, file)} is not browser-importable`)
}

const runnerManifest = JSON.parse(readFileSync(path.join(root, 'apps/runner/package.json'), 'utf8'))
const serverManifest = JSON.parse(readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'))
for (const [name, manifest] of [['runner', runnerManifest], ['server', serverManifest]]) {
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  if (dependencies.electron) failures.push(`${name} declares Electron`)
  if (dependencies['@maestrly/desktop']) failures.push(`${name} declares desktop`)
}

const desktopBuilder = readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8')
if (!/^appId: io\.github\.antonioducs\.maestrly$/m.test(desktopBuilder)) failures.push('desktop appId changed')
if (!statSync(path.join(root, 'LICENSE')).isFile() || !/MIT License/.test(readFileSync(path.join(root, 'LICENSE'), 'utf8'))) failures.push('MIT license missing')

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('[boundaries] four products and focused packages are isolated.\n')
