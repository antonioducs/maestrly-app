// Guest-side diagnostic: framebuffer updates per second read directly from a session's private
// RFB socket (root only), to separate the screen server from the virtio media lane.
import { performance } from 'node:perf_hooks'
import { RfbClient } from './rfb-client.mjs'

const client = await RfbClient.connect(process.argv[2])
await client.update(false, 5000)
let bytes = 0
const start = client.updates
const started = performance.now()
while (performance.now() - started < 3000) await client.update(true, 1000).catch(() => {})
bytes = client.width * client.height * 4
process.stdout.write(`${JSON.stringify({ updatesPerSecond: Math.round(((client.updates - start) / ((performance.now() - started) / 1000)) * 10) / 10, framebufferBytes: bytes })}\n`)
client.close()
