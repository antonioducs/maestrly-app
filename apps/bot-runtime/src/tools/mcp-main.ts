import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { bridgeRequest } from './bridge.js'
import { serveMcp } from './mcp-server.js'
export function main() {
  const state = process.env.MAESTRLY_BOT_STATE ?? '/var/lib/maestrly-bot'
  const prefix = randomUUID()
  serveMcp(process.stdin, process.stdout, '0.1.0', (id, method, params) =>
    bridgeRequest(join(state, 'tools.sock'), id, method, {
      ...params,
      turnId: process.env.MAESTRLY_BOT_TURN_ID,
      requestId: prefix + ':' + String(id),
    })
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main()
