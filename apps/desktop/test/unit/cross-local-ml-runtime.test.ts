import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGzip } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import tar from 'tar-stream'
import { assertWindowsX64Pe, verifyCrossLocalMlRuntime } from '../../../../scripts/verify-cross-local-ml-runtime.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function pe(machine = 0x8664, optionalHeaderMagic = 0x20b) {
  const binary = Buffer.alloc(512)
  binary.write('MZ', 0, 'ascii')
  binary.writeUInt32LE(0x80, 0x3c)
  binary.write('PE\0\0', 0x80, 'ascii')
  binary.writeUInt16LE(machine, 0x84)
  binary.writeUInt16LE(optionalHeaderMagic, 0x98)
  return binary
}

async function fixture(files: Record<string, Buffer | string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cross-local-ml-test-'))
  temporaryRoots.push(directory)
  const archive = path.join(directory, 'local-ml-runtime-2.17.2-1-win-x64.tar.gz')
  const sidecar = archive.replace(/\.tar\.gz$/, '.json')
  const pack = tar.pack()
  const destination = createWriteStream(archive)
  pack.pipe(createGzip({ level: 9 })).pipe(destination)
  let unpackedBytes = 0
  for (const [name, value] of Object.entries(files)) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value)
    unpackedBytes += content.length
    pack.entry({ name, size: content.length, type: 'file' }, content)
  }
  pack.finalize()
  await new Promise<void>((resolve, reject) => {
    destination.once('close', resolve).once('error', reject)
  })
  const contents = await readFile(archive)
  await writeFile(
    sidecar,
    `${JSON.stringify({
      schema: 1,
      version: '2.17.2-1',
      target: 'win-x64',
      sha256: createHash('sha256').update(contents).digest('hex'),
      archiveBytes: (await stat(archive)).size,
      unpackedBytes,
      criticalPaths: Object.keys(files),
    })}\n`
  )
  return { archive, sidecar }
}

function requiredFiles() {
  return {
    'runtime.mjs': 'export const env = {}; export function pipeline() {}',
    'node_modules/@xenova/transformers/package.json': '{}',
    'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node': pe(),
    'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll': pe(),
    'node_modules/sharp/package.json': '{}',
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node': pe(),
    'node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.6.dll': pe(),
  }
}

describe('cross local-ML runtime verifier', () => {
  it('accepts a hashed win-x64 archive whose native files are PE x64', async () => {
    const artifact = await fixture(requiredFiles())
    const result = await verifyCrossLocalMlRuntime({ ...artifact, target: 'win-x64' })

    expect(result.files).toBe(7)
    expect(result.peFiles).toBe(4)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a Windows ARM64 native binary', async () => {
    const files = requiredFiles()
    files['node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node'] = pe(0xaa64)
    const artifact = await fixture(files)

    await expect(verifyCrossLocalMlRuntime({ ...artifact, target: 'win-x64' })).rejects.toThrow(
      /expected PE32\+ x86-64/
    )
  })

  it('rejects a PE32 binary even when its machine field says x86-64', async () => {
    const files = requiredFiles()
    files['node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node'] = pe(0x8664, 0x10b)
    const artifact = await fixture(files)

    await expect(verifyCrossLocalMlRuntime({ ...artifact, target: 'win-x64' })).rejects.toThrow(
      /optional-header magic 0x20b/
    )
  })

  it('rejects native files from another ONNX target', async () => {
    const artifact = await fixture({
      ...requiredFiles(),
      'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node': pe(),
    })

    await expect(verifyCrossLocalMlRuntime({ ...artifact, target: 'win-x64' })).rejects.toThrow(
      /foreign ONNX native target/
    )
  })

  it('parses the PE machine header defensively', () => {
    expect(() => assertWindowsX64Pe(Buffer.from('not-a-pe'), 'binding.node')).toThrow(/missing MZ header/)
  })

  it('rejects archive paths that the production extractor would reject on Windows', async () => {
    const artifact = await fixture({ ...requiredFiles(), 'node_modules\\escaped.dll': pe() })

    await expect(verifyCrossLocalMlRuntime({ ...artifact, target: 'win-x64' })).rejects.toThrow(/Unsafe archive entry/)
  })
})
