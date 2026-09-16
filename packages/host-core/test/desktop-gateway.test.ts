import { duplexPair } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { handleDesktopAttach } from '../src/desktop/gateway.js'
import { HostError } from '../src/errors.js'

const ticket = 'c'.repeat(64)
const replyOf = (client: NodeJS.ReadableStream) =>
  new Promise<string>((resolve) => {
    let text = ''
    client.on('data', (chunk) => {
      text += chunk.toString()
      if (text.includes('\n')) resolve(text.slice(0, text.indexOf('\n')))
    })
  })
it('exchanges a single bounded line for raw RFB bytes, forwarding bytes that followed the line', async () => {
  const [client, server] = duplexPair()
  const [ours, guest] = duplexPair()
  const attach = vi.fn(async () => ({ stream: ours, width: 1280, height: 800 }))
  const done = handleDesktopAttach(server, attach)
  const reply = replyOf(client)
  client.write(`${JSON.stringify({ version: 1, ticket })}\nRFB 003.008\n`)
  expect(JSON.parse(await reply)).toEqual({ accepted: true, width: 1280, height: 800 })
  expect(attach).toHaveBeenCalledWith(ticket)
  const fromClient = await new Promise<string>((resolve) => guest.once('data', (chunk) => resolve(chunk.toString())))
  expect(fromClient).toBe('RFB 003.008\n')
  const back = new Promise<string>((resolve) => client.once('data', (chunk) => resolve(chunk.toString())))
  guest.write('framebuffer')
  expect(await back).toBe('framebuffer')
  // The media stream ending closes the attach connection.
  ours.destroy()
  await done
  expect(client.destroyed || server.destroyed).toBe(true)
})
it.each([
  ['malformed JSON', 'not json\n'],
  ['wrong version', `${JSON.stringify({ version: 2, ticket })}\n`],
  ['extra fields', `${JSON.stringify({ version: 1, ticket, host: 'evil', port: 5900 })}\n`],
  ['oversized line', `${'x'.repeat(600)}\n`],
])('refuses %s without contacting the guest', async (_name, line) => {
  const [client, server] = duplexPair()
  const attach = vi.fn()
  const done = handleDesktopAttach(server, attach)
  const reply = replyOf(client)
  client.write(line)
  expect(JSON.parse(await reply)).toEqual({ accepted: false, code: 'ATTACH_INVALID' })
  await done
  expect(attach).not.toHaveBeenCalled()
})
it('reports stable refusal codes and times out idle attachers', async () => {
  const [client, server] = duplexPair()
  const done = handleDesktopAttach(server, async () => { throw new HostError('TICKET_INVALID', '/secret/path leaked?') })
  const reply = replyOf(client)
  client.write(`${JSON.stringify({ version: 1, ticket })}\n`)
  const text = await reply
  expect(JSON.parse(text)).toEqual({ accepted: false, code: 'TICKET_INVALID' })
  expect(text).not.toContain('secret')
  await done
  const [idle, idleServer] = duplexPair()
  const idleReply = replyOf(idle)
  await handleDesktopAttach(idleServer, vi.fn(), 50)
  expect(JSON.parse(await idleReply)).toEqual({ accepted: false, code: 'ATTACH_TIMEOUT' })
})
