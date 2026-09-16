const skipWindows = process.platform === 'win32'
import { connect } from 'node:net'
import { mkdtemp, realpath, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { duplexPair, PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { startSocket } from '../src/rpc-server.js'
import { startDesktopSocket } from '../src/desktop-server.js'
import { readAttachLine } from '../src/desktop-stdio.js'

const ticket = 'e'.repeat(64)
it.skipIf(skipWindows)('binds each RPC connection to its own identity and reports when it closes', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mh-ctx-'))
  const seen: string[] = []
  const closed: string[] = []
  const close = await startSocket(join(dir, 'rpc'), async (request, context) => {
    seen.push(context.connectionId)
    return { version: 1, id: request.id, result: {} }
  }, () => {}, (connectionId) => closed.push(connectionId))
  try {
    const roundTrip = () => new Promise<void>((resolve, reject) => {
      const socket = connect(join(dir, 'rpc'), () => socket.write('{"version":1,"id":"x","method":"host.inspect","params":{}}\n'))
      socket.on('error', reject)
      socket.once('data', () => {
        socket.destroy()
        resolve()
      })
    })
    await roundTrip()
    await roundTrip()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(new Set(seen).size).toBe(2)
    expect(closed.sort()).toEqual([...seen].sort())
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})
it.skipIf(skipWindows)('the desktop socket carries RFB bytes only after a valid ticket line', async () => {
  const dir = await realpath(await mkdtemp('/tmp/mh-desk-'))
  const path = join(dir, 'desktop')
  const guests: import('node:stream').Duplex[] = []
  const close = await startDesktopSocket(path, async (value) => {
    if (value !== ticket) throw Object.assign(new Error('bad'), { code: 'TICKET_INVALID' })
    const [ours, guest] = duplexPair()
    guests.push(guest)
    guest.write('RFB 003.008\n')
    return { stream: ours, width: 1280, height: 800 }
  })
  try {
    expect((await lstat(path)).mode & 0o777).toBe(0o660)
    const text = (line: string) => new Promise<string>((resolve, reject) => {
      let data = ''
      const socket = connect(path, () => socket.write(line))
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        data += chunk.toString()
        if (data.split('\n').length > 2 || data.includes('"accepted":false')) {
          socket.destroy()
          resolve(data)
        }
      })
    })
    const accepted = await text(`${JSON.stringify({ version: 1, ticket })}\n`)
    expect(accepted).toBe('{"accepted":true,"width":1280,"height":800}\nRFB 003.008\n')
    expect(JSON.parse((await text(`${JSON.stringify({ version: 1, ticket: 'f'.repeat(64) })}\n`)).trim())).toEqual({ accepted: false, code: 'TICKET_INVALID' })
    expect(guests).toHaveLength(1)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})
it('reads exactly one bounded attach line and keeps the following bytes', async () => {
  const input = new PassThrough()
  const pending = readAttachLine(input)
  input.write(Buffer.from('{"version":1}\nRFB'))
  const { line, rest } = await pending
  expect(line).toBe('{"version":1}')
  expect(rest.toString()).toBe('RFB')
  const long = new PassThrough()
  const tooLong = readAttachLine(long, 16)
  long.write('x'.repeat(40))
  await expect(tooLong).rejects.toThrow('too long')
  const empty = new PassThrough()
  const missing = readAttachLine(empty)
  empty.end('no newline')
  await expect(missing).rejects.toThrow('missing')
})
