// Run inside an environment container with ELECTRON_RUN_AS_NODE=1 to prove passive RFB cursor pixels move. Port 5901
// is the environment screen view (tile 0 of :0), whose VNC server starts on demand: keep a view of it open meanwhile.
import net from 'node:net'
import { execFileSync } from 'node:child_process'

const socket = net.connect(5901, '127.0.0.1')
let queue = Buffer.alloc(0)
let pending = null
socket.on('data', (chunk) => {
  queue = Buffer.concat([queue, chunk])
  pending?.()
})
function take(size) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (queue.length < size) return
      const result = queue.subarray(0, size)
      queue = queue.subarray(size)
      pending = null
      socket.off('error', reject)
      resolve(result)
    }
    pending = check
    socket.once('error', reject)
    check()
  })
}
await take(12)
socket.write('RFB 003.008\n')
const count = (await take(1))[0]
const security = await take(count)
if (!security.includes(1)) throw new Error('NoAuth unavailable')
socket.write(Buffer.from([1]))
if ((await take(4)).readUInt32BE(0) !== 0) throw new Error('Authentication failed')
socket.write(Buffer.from([1]))
const init = await take(24)
const width = init.readUInt16BE(0)
const height = init.readUInt16BE(2)
const bytesPerPixel = init[4] / 8
await take(init.readUInt32BE(20))
if (bytesPerPixel !== 4) throw new Error(`Unexpected bpp: ${bytesPerPixel}`)
// Raw encoding only: every framebuffer pixel, including the server-rendered cursor, arrives in the update.
socket.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]))
async function capture() {
  socket.write(Buffer.from([3, 0, 0, 0, 0, 0, width >> 8, width & 255, height >> 8, height & 255]))
  const header = await take(4)
  const count = header.readUInt16BE(2)
  const image = Buffer.alloc(width * height * 4)
  for (let i = 0; i < count; i++) {
    const rect = await take(12)
    const x = rect.readUInt16BE(0)
    const y = rect.readUInt16BE(2)
    const w = rect.readUInt16BE(4)
    const h = rect.readUInt16BE(6)
    if (rect.readInt32BE(8) !== 0) throw new Error('Unexpected encoding')
    const pixels = await take(w * h * 4)
    for (let row = 0; row < h; row++) {
      pixels.copy(image, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4)
    }
  }
  return image
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 2000))
execFileSync('xdotool', ['mousemove', '900', '650'])
await pause()
const first = await capture()
execFileSync('xdotool', ['mousemove', '1050', '650'])
await pause()
const second = await capture()
let changed = 0
for (const x of [900, 1050]) {
  for (let y = 645; y < 675; y++) for (let xx = x - 5; xx < x + 25; xx++) {
    const offset = (y * width + xx) * 4
    if (!first.subarray(offset, offset + 4).equals(second.subarray(offset, offset + 4))) changed++
  }
}
console.log(JSON.stringify({ width, height, changedCursorRegionPixels: changed }))
socket.end()
if (changed === 0) process.exitCode = 1
