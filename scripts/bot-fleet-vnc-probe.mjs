#!/usr/bin/env node
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function runDocker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `docker exited ${result.status}`)
  return result.stdout.trim()
}
function mouse(container) {
  const output = runDocker(['exec', container, 'xdotool', 'getmouselocation', '--shell'])
  return `${/^X=(\d+)/m.exec(output)?.[1]},${/^Y=(\d+)/m.exec(output)?.[1]}`
}
function move(port, x, y) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(5000, () => socket.destroy(new Error('RFB timeout')))
    let stage = 0
    let buffer = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        if (stage === 0 && buffer.length >= 12) {
          buffer = buffer.subarray(12)
          socket.write('RFB 003.008\n')
          stage = 1
        } else if (stage === 1 && buffer.length >= 1 + buffer[0]) {
          const count = buffer[0]
          if (count === 0 || !buffer.subarray(1, 1 + count).includes(1))
            return reject(new Error('RFB NoAuth unavailable'))
          buffer = buffer.subarray(1 + count)
          socket.write(Buffer.from([1]))
          stage = 2
        } else if (stage === 2 && buffer.length >= 4) {
          if (buffer.readUInt32BE(0) !== 0) return reject(new Error('RFB authentication failed'))
          buffer = buffer.subarray(4)
          socket.write(Buffer.from([1]))
          stage = 3
        } else if (stage === 3 && buffer.length >= 24) {
          const nameLength = buffer.readUInt32BE(20)
          if (buffer.length < 24 + nameLength) break
          socket.write(Buffer.from([5, 0, x >> 8, x & 255, y >> 8, y & 255]))
          setTimeout(() => {
            socket.end()
            resolve()
          }, 300)
          stage = 4
          break
        } else break
      }
    })
  })
}

if (process.argv[2] === '--client') {
  await move(Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]))
} else {
  const container = process.argv[2] ?? 'maestrly-bot-probe'
  runDocker(['cp', fileURLToPath(import.meta.url), `${container}:/tmp/bot-fleet-vnc-probe.mjs`])
  const before = mouse(container)
  runDocker([
    'exec',
    '-e',
    'ELECTRON_RUN_AS_NODE=1',
    container,
    '/opt/maestrly/node_modules/electron/dist/electron',
    '/tmp/bot-fleet-vnc-probe.mjs',
    '--client',
    '5901',
    '220',
    '180',
  ])
  const view = mouse(container)
  runDocker([
    'exec',
    '-e',
    'ELECTRON_RUN_AS_NODE=1',
    container,
    '/opt/maestrly/node_modules/electron/dist/electron',
    '/tmp/bot-fleet-vnc-probe.mjs',
    '--client',
    '5900',
    '440',
    '310',
  ])
  const control = mouse(container)
  console.log(JSON.stringify({ before, afterViewOnly: view, afterControl: control }))
  if (before !== view || control !== '440,310') process.exitCode = 1
}
