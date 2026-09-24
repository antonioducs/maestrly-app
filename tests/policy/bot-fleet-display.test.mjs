import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../deploy/bot-fleet/prepare-xvfb-display.sh', import.meta.url))

function scenario(displayActive) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fleet-display-'))
  try {
    const lock = path.join(directory, 'X0.lock')
    const socket = path.join(directory, 'X0')
    writeFileSync(lock, 'old pid')
    writeFileSync(socket, 'old socket')
    const xdpyinfo = path.join(directory, 'xdpyinfo')
    writeFileSync(xdpyinfo, '#!/bin/sh\nexit ' + (displayActive ? '0' : '1') + '\n', { mode: 0o755 })
    const result = spawnSync('sh', [script, ':0', lock, socket], {
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH },
      encoding: 'utf8',
    })
    return { status: result.status, lock: existsSync(lock), socket: existsSync(socket) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('removes stale Xvfb display files before restart', () => {
  assert.deepEqual(scenario(false), { status: 0, lock: false, socket: false })
})

test('leaves a live display untouched', () => {
  assert.deepEqual(scenario(true), { status: 1, lock: true, socket: true })
})
