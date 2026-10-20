import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error executable ESM script
import * as afterPack from '../../../../scripts/after-pack.mjs'

const { findLeanCoreLeaks, foreignMachOFiles, machOCpuTypes, missingLegalResources, REQUIRED_LEGAL_RESOURCES } =
  afterPack

const ARM64 = 0x0100000c
const X64 = 0x01000007

function thinMachO(cpuType: number) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  return header
}

function fatMachO(cpuTypes: number[]) {
  const header = Buffer.alloc(8 + cpuTypes.length * 20)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(cpuTypes.length, 4)
  cpuTypes.forEach((cpuType, index) => header.writeUInt32BE(cpuType, 8 + index * 20))
  return header
}

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

describe('macOS architecture gate', () => {
  it('reads thin and fat Mach-O headers and ignores other files', () => {
    expect(machOCpuTypes(thinMachO(ARM64))).toEqual([ARM64])
    expect(machOCpuTypes(fatMachO([X64, ARM64]))).toEqual([X64, ARM64])
    // A Java class file: 0xcafebabe, then minor version 0 and major version 55.
    expect(machOCpuTypes(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 55]))).toBeNull()
    expect(machOCpuTypes(Buffer.from('#!/bin/sh\n'))).toBeNull()
    expect(machOCpuTypes(Buffer.alloc(0))).toBeNull()
  })

  it('reports every Mach-O without code for the packaged architecture', async () => {
    const bundle = mkdtempSync(path.join(os.tmpdir(), 'maestrly-macho-'))
    tempDirs.push(bundle)
    const files: Record<string, Buffer> = {
      'Contents/MacOS/Maestrly App': thinMachO(ARM64),
      'Contents/Frameworks/universal.dylib': fatMachO([X64, ARM64]),
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper': thinMachO(ARM64),
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper': thinMachO(X64),
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/pty.node': Buffer.from('MZ'),
      'Contents/Info.plist': Buffer.from('<plist/>'),
    }
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(bundle, ...relative.split('/'))
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, bytes)
    }

    const nodePty = path.join('Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
    expect(await foreignMachOFiles(bundle, 'arm64')).toEqual([
      path.join(nodePty, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    ])
    expect(await foreignMachOFiles(bundle, 'x64')).toEqual([
      path.join('Contents', 'MacOS', 'Maestrly App'),
      path.join(nodePty, 'build', 'Release', 'spawn-helper'),
    ])
    expect(await foreignMachOFiles(bundle, 'universal')).toEqual([])
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
