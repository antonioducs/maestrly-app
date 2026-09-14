import { afterEach, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { JsonChannel } from '../src/qmp.js'
import { installGuestRuntime } from '../src/guest/install.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
it('transfers a bundle using a QGA-supported mode and verifies its guest digest and installation marker', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bot-install-')))
  directories.push(directory)
  const path = join(directory, 'runtime.tar')
  const payload = Buffer.alloc(100_000, 7)
  await writeFile(path, payload)
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const chunks: Buffer[] = []
  let output = ''
  let installed = false
  const channel = {
    async command(method: string, args: Record<string, any>) {
      if (method === 'guest-exec') {
        output = args.path === '/usr/bin/sha256sum' ? `${sha256}  bundle.tar` : args.path === '/usr/bin/cat' ? JSON.stringify({ version: 'test', sha256 }) : ''
        if (args.path === '/bin/sh') installed = true
        return { pid: 1 }
      }
      if (method === 'guest-exec-status') return { exited: true, exitcode: 0, 'out-data': Buffer.from(output).toString('base64') }
      if (method === 'guest-file-open') {
        // QGA's find_open_flag has an explicit list, unlike libc fopen.
        if (!['r', 'rb', 'w', 'wb', 'a', 'ab', 'r+', 'rb+', 'r+b', 'w+', 'wb+', 'w+b', 'a+', 'ab+', 'a+b'].includes(args.mode))
          throw Error(`invalid file open mode '${args.mode}'`)
        return 9
      }
      if (method === 'guest-file-write') {
        expect(args.handle).toBe(9)
        const bytes = Buffer.from(args['buf-b64'], 'base64')
        chunks.push(bytes)
        return { count: bytes.length }
      }
      if (method === 'guest-file-close' || method === 'guest-file-flush') return {}
      throw Error(`Unexpected command ${method}`)
    },
  } as unknown as JsonChannel
  await expect(installGuestRuntime(channel, { path, sha256, version: 'test' }, new AbortController().signal)).resolves.toEqual({ version: 'test', digest: sha256 })
  expect(Buffer.concat(chunks)).toEqual(payload)
  expect(installed).toBe(true)
})
