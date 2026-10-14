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

for (const scope of [
  'apps/bot-gateway/src',
  'apps/mobile/src',
  'packages/protocol/src',
  'packages/bot-fleet-protocol/src',
  'packages/artifact-host/src',
]) {
  for (const file of files(path.join(root, scope))) {
    const source = readFileSync(file, 'utf8')
    if (/(?:from\s*|import\s*\()['"]electron/.test(source))
      failures.push(`${path.relative(root, file)} imports Electron`)
    if (/(?:from\s*|import\s*\()['"][^'"]*apps\/desktop/.test(source))
      failures.push(`${path.relative(root, file)} imports desktop code`)
  }
}

for (const scope of ['packages/protocol/src', 'packages/bot-fleet-protocol/src']) {
  for (const file of files(path.join(root, scope))) {
    if (/(?:from\s*|import\s*\()['"]node:/.test(readFileSync(file, 'utf8')))
      failures.push(`${path.relative(root, file)} is not browser-importable`)
  }
}

const gatewayManifest = JSON.parse(readFileSync(path.join(root, 'apps/bot-gateway/package.json'), 'utf8'))
const gatewayDependencies = { ...gatewayManifest.dependencies, ...gatewayManifest.devDependencies }
if (gatewayDependencies.electron) failures.push('bot-gateway declares Electron')
if (gatewayDependencies['@maestrly/desktop']) failures.push('bot-gateway declares desktop')

const desktopBuilder = readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8')
if (!/^appId: io\.github\.antonioducs\.maestrly$/m.test(desktopBuilder)) failures.push('desktop appId changed')
if (
  !statSync(path.join(root, 'LICENSE')).isFile() ||
  !/MIT License/.test(readFileSync(path.join(root, 'LICENSE'), 'utf8'))
)
  failures.push('MIT license missing')

if (failures.length > 0) {
  process.stderr.write(`${failures.map((failure) => `- ${failure}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('[boundaries] products and focused packages are isolated.\n')
