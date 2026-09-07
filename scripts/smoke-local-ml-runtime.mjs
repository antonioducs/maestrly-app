#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractLocalMlArchive as extractArchive } from './extract-local-ml-archive.mjs'

const hostOs = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform

async function verifyExtractedRuntime(temporary) {
  const runtimeEntry = path.join(temporary, 'runtime.mjs')
  const runtime = await import(pathToFileURL(runtimeEntry).href)
  if (typeof runtime.pipeline !== 'function' || !runtime.env) {
    throw new Error('Runtime entry does not export pipeline/env')
  }
  const requireFromRuntime = createRequire(pathToFileURL(runtimeEntry))
  const ort = requireFromRuntime('onnxruntime-node')
  if (typeof ort.InferenceSession?.create !== 'function') {
    throw new Error('onnxruntime-node native binding did not load')
  }
  const sharp = requireFromRuntime('sharp')
  const pixel = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#000' } })
    .png()
    .toBuffer()
  if (pixel.length === 0) throw new Error('sharp native smoke returned an empty image')
}

async function runVerificationChild(temporary) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--verify-extracted', temporary], {
    stdio: 'inherit',
    windowsHide: true,
  })
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (code !== 0) {
    throw new Error(`Local ML native verification child exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
  }
}

async function removeTemporaryTree(temporary) {
  const expiresAt = Date.now() + 10_000
  while (true) {
    try {
      await rm(temporary, { recursive: true, force: true })
      return
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code) || Date.now() >= expiresAt) throw error
      await delay(100)
    }
  }
}

async function main() {
  if (process.argv[2] === '--verify-extracted') {
    if (!process.argv[3] || process.argv.length !== 4) {
      throw new Error('Usage: smoke-local-ml-runtime.mjs --verify-extracted <directory>')
    }
    await verifyExtractedRuntime(path.resolve(process.argv[3]))
    return
  }

  if (process.argv.length > 3) throw new Error(`Unexpected extra arguments: ${process.argv.slice(3).join(' ')}`)
  const archive =
    process.argv[2] ??
    path.join('runtime-assets', 'local-ml', 'archives', `local-ml-runtime-2.17.2-1-${hostOs}-${process.arch}.tar.gz`)
  const resolvedArchive = path.resolve(archive)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'local-ml-smoke-'))
  try {
    await extractArchive(resolvedArchive, temporary)
    await runVerificationChild(temporary)
    console.log(`[smoke-local-ml-runtime] ok: ${resolvedArchive} (models remained lazy)`)
  } finally {
    await removeTemporaryTree(temporary)
  }
}

await main()
