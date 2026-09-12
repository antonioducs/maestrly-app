import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error executable ESM script
import * as afterPack from '../../../../scripts/after-pack.mjs'

const { findLeanCoreLeaks, missingLegalResources, REQUIRED_LEGAL_RESOURCES } = afterPack

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function resourcesWith(packages: string[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-leakage-'))
  tempDirs.push(root)
  const source = path.join(root, 'source')
  const resources = path.join(root, 'Resources')
  for (const name of packages) {
    const dir = path.join(source, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), '{}')
  }
  mkdirSync(resources)
  await createPackage(source, path.join(resources, 'app.asar'))
  return resources
}

describe('lean core leakage gate', () => {
  it('allows only the target native optional package', async () => {
    const resources = await resourcesWith(['@github/copilot-darwin-arm64'])
    expect(await findLeanCoreLeaks(resources, 'mac', 'arm64')).toEqual([])
  })

  it('rejects foreign and duplicate platform optional packages', async () => {
    const resources = await resourcesWith(['@github/copilot-darwin-arm64', '@github/copilot-linux-x64'])
    const leaks = await findLeanCoreLeaks(resources, 'mac', 'arm64')
    expect(leaks.join('\n')).toMatch(/foreign optional package @github\/copilot-linux-x64/)
    expect(leaks.join('\n')).toMatch(/duplicate optional packages/)
  })

  it('rejects the local ML closure in either packed or unpacked core resources', async () => {
    const packed = await resourcesWith(['@xenova/transformers'])
    expect((await findLeanCoreLeaks(packed, 'mac', 'arm64')).join('\n')).toMatch(/local ML package/)

    const unpacked = await resourcesWith([])
    const leaked = path.join(unpacked, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node')
    mkdirSync(leaked, { recursive: true })
    writeFileSync(path.join(leaked, 'package.json'), '{}')
    expect((await findLeanCoreLeaks(unpacked, 'mac', 'arm64')).join('\n')).toMatch(/onnxruntime-node/)
  })

  it('rejects a tunnel-client payload from packaged resources', async () => {
    const resources = await resourcesWith([])
    mkdirSync(path.join(resources, 'tunnel-client'), { recursive: true })
    expect(await findLeanCoreLeaks(resources, 'mac', 'arm64')).toContain('Resources/tunnel-client')
  })
})

describe('packaged legal resources', () => {
  it('requires every project and third-party notice as a non-empty file', async () => {
    const resources = await resourcesWith([])
    expect(missingLegalResources(resources)).toEqual(REQUIRED_LEGAL_RESOURCES)

    for (const relative of REQUIRED_LEGAL_RESOURCES) {
      const file = path.join(resources, ...relative.split('/'))
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, 'notice\n')
    }
    expect(missingLegalResources(resources)).toEqual([])

    writeFileSync(path.join(resources, 'LICENSE.txt'), '')
    expect(missingLegalResources(resources)).toEqual(['LICENSE.txt'])
  })
})
