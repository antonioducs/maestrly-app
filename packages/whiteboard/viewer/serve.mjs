#!/usr/bin/env node
// Spike: serves the board for a person to try. Press Enter for a fresh owner link (each works once).
import { startSpikeHost } from './spike-host.mjs'

const host = await startSpikeHost(Number(process.env.PORT ?? 4817))
console.log(`files=${host.files} bytes=${host.totalBytes}`)
console.log(`OWNER_URL=${await host.ownerUrl()}`)

const stop = async () => {
  await host.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('data', async () => console.log(`OWNER_URL=${await host.ownerUrl()}`))
