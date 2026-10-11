import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BotDesktopService,
  type BotDesktopServiceDeps,
  DESKTOP_URL_MAX,
  type DesktopTerminals,
  type PresenterLink,
} from '../../src/main/fleet/instance/desktop/desktop-service'
import {
  FRAME,
  FrameReader,
  encodeFrame,
  encodeLine,
  encodeText,
  exitPayload,
  parseExitPayload,
  sizePayload,
} from '../../src/main/fleet/instance/desktop/socket-protocol'

const CONVERSATION = 'conv-alpha'
const OTHER_CONVERSATION = 'conv-beta'
const MESSAGES = {
  presenterUnavailable: 'Presenter unavailable',
  noConversation: 'No conversation',
  invalidUrl: 'Invalid URL',
  terminalFailed: 'Terminal failed',
  exit: (code: number) => `Process ended with code ${code}`,
}

interface FakePty {
  id: string
  conversationId: string
  alive: boolean
  data: string
  generation: number
  sequence: number
  outputListeners: Set<(data: string, meta: { generation: number; sequence: number }) => void>
  exitListeners: Set<(code: number) => void>
}

class FakeTerminals implements DesktopTerminals {
  readonly ptys = new Map<string, FakePty>()
  readonly created: Array<[string, string]> = []
  readonly writes: Array<[string, string]> = []
  readonly resizes: Array<[string, number, number]> = []
  createFailure: string | null = null
  /** Runs inside `snapshot`, to put output between the subscription and the snapshot. */
  beforeSnapshot: ((id: string) => void) | null = null
  private counter = 0

  add(conversationId: string, id = `term:${conversationId}:${++this.counter}`, data = ''): FakePty {
    const pty: FakePty = {
      id,
      conversationId,
      alive: true,
      data,
      generation: 1,
      sequence: data ? 1 : 0,
      outputListeners: new Set(),
      exitListeners: new Set(),
    }
    this.ptys.set(id, pty)
    return pty
  }

  /** Like the real list, it still holds terminals whose process ended. */
  list(conversationId: string): Array<{ id: string }> {
    return [...this.ptys.values()].filter((pty) => pty.conversationId === conversationId).map(({ id }) => ({ id }))
  }

  create(conversationId: string, cwd: string): { ok: true; id: string } | { ok: false; reason: string } {
    this.created.push([conversationId, cwd])
    if (this.createFailure) return { ok: false, reason: this.createFailure }
    return { ok: true, id: this.add(conversationId).id }
  }

  belongsTo(conversationId: string, id: string): boolean {
    return this.ptys.get(id)?.conversationId === conversationId
  }

  exists(id: string): boolean {
    return this.ptys.get(id)?.alive === true
  }

  snapshot(id: string): { data: string; generation: number; sequence: number } {
    this.beforeSnapshot?.(id)
    const pty = this.ptys.get(id)
    return { data: pty?.data ?? '', generation: pty?.generation ?? 0, sequence: pty?.sequence ?? 0 }
  }

  write(id: string, data: string): boolean {
    this.writes.push([id, data])
    return this.exists(id)
  }

  resize(id: string, cols: number, rows: number): void {
    this.resizes.push([id, cols, rows])
  }

  onOutput(id: string, listener: (data: string, meta: { generation: number; sequence: number }) => void): () => void {
    this.ptys.get(id)?.outputListeners.add(listener)
    return () => this.ptys.get(id)?.outputListeners.delete(listener)
  }

  onExit(id: string, listener: (code: number) => void): () => void {
    this.ptys.get(id)?.exitListeners.add(listener)
    return () => this.ptys.get(id)?.exitListeners.delete(listener)
  }

  title(id: string): string {
    return `Title of ${id}`
  }

  /** The pty prints `data`: it enters the ring buffer and reaches the listeners, as in pty-manager. */
  emit(id: string, data: string): void {
    const pty = this.ptys.get(id)!
    pty.sequence += 1
    // The real ring buffer keeps the last 256 KiB.
    pty.data = (pty.data + data).slice(-256 * 1024)
    for (const listener of [...pty.outputListeners])
      listener(data, { generation: pty.generation, sequence: pty.sequence })
  }

  restart(id: string): void {
    const pty = this.ptys.get(id)!
    pty.generation += 1
    pty.sequence = 0
    pty.data = ''
  }

  exit(id: string, code: number): void {
    const pty = this.ptys.get(id)!
    pty.alive = false
    for (const listener of [...pty.exitListeners]) listener(code)
  }

  listeners(id: string): number {
    const pty = this.ptys.get(id)
    return (pty?.outputListeners.size ?? 0) + (pty?.exitListeners.size ?? 0)
  }
}

/** A client of the socket that keeps what it receives and reads lines and frames from it on demand. */
class Client {
  private buffer = Buffer.alloc(0)
  private readonly reader = new FrameReader()
  private readonly parsed: Array<{ type: number; payload: Buffer }> = []
  private framing = false
  closed = false

  private constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      if (this.framing) this.pump()
    })
    socket.on('close', () => {
      this.closed = true
    })
    socket.on('error', () => {})
  }

  static connect(socketPath: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath)
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.off('error', reject)
        resolve(new Client(socket))
      })
    })
  }

  send(data: Buffer | string): void {
    this.socket.write(data)
  }

  async line(): Promise<string[]> {
    await vi.waitFor(
      () => {
        if (!this.buffer.includes(10)) throw new Error('no line yet')
      },
      { interval: 5 }
    )
    const end = this.buffer.indexOf(10)
    const text = this.buffer.subarray(0, end).toString('utf8')
    this.buffer = this.buffer.subarray(end + 1)
    return text.split('\t')
  }

  private pump(): void {
    const chunk = this.buffer
    this.buffer = Buffer.alloc(0)
    this.parsed.push(...this.reader.push(chunk))
  }

  async frames(count: number): Promise<Array<{ type: number; payload: Buffer }>> {
    this.framing = true
    this.pump()
    await vi.waitFor(
      () => {
        if (this.parsed.length < count) throw new Error(`${this.parsed.length}/${count} frames`)
      },
      { interval: 5 }
    )
    return this.parsed.splice(0, count)
  }

  /** The text of the next data frames, until `text` is the whole output received so far. */
  async output(expected: string): Promise<void> {
    let text = ''
    this.framing = true
    await vi.waitFor(
      () => {
        this.pump()
        for (const frame of this.parsed.splice(0)) {
          if (frame.type === FRAME.data) text += frame.payload.toString('utf8')
        }
        if (text.length < expected.length) throw new Error(`got ${JSON.stringify(text)}`)
      },
      { interval: 5 }
    )
    expect(text).toBe(expected)
  }

  async noMoreFrames(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 40))
    this.framing = true
    this.pump()
    expect(this.parsed).toEqual([])
  }

  async waitClosed(): Promise<void> {
    await vi.waitFor(
      () => {
        if (!this.closed) throw new Error('still open')
      },
      { interval: 5 }
    )
  }

  close(): void {
    this.socket.destroy()
  }
}

interface Fixture {
  service: BotDesktopService
  deps: BotDesktopServiceDeps
  terminals: FakeTerminals
  viewers: { show: ReturnType<typeof vi.fn> }
  openUrl: ReturnType<typeof vi.fn>
  openFiles: ReturnType<typeof vi.fn>
  presentBrowser: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  socketPath: string
  directory: string
  clients: Client[]
  connect(): Promise<Client>
  command(...fields: string[]): Promise<string[]>
}

const fixtures: Fixture[] = []

async function fixture(
  overrides: Partial<BotDesktopServiceDeps> & { conversation?: string | null; cwd?: string | null } = {}
): Promise<Fixture> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'md-'))
  const socketPath = path.join(directory, 'desktop.sock')
  const terminals = new FakeTerminals()
  const viewers = { show: vi.fn(async () => {}) }
  const openUrl = vi.fn(async () => {})
  const openFiles = vi.fn(async () => {})
  const presentBrowser = vi.fn(async () => {})
  const log = vi.fn()
  const { conversation, cwd, ...rest } = overrides
  const deps: BotDesktopServiceDeps = {
    socketPath,
    conversationId: () => (conversation === undefined ? CONVERSATION : conversation),
    conversationCwd: () => (cwd === undefined ? '/home/bot/work' : cwd),
    terminals,
    viewers,
    openFiles,
    openUrl,
    presentBrowser,
    messages: MESSAGES,
    log,
    ...rest,
  }
  const service = new BotDesktopService(deps)
  await service.start()
  const clients: Client[] = []
  const created: Fixture = {
    service,
    deps,
    terminals,
    viewers,
    openUrl,
    openFiles,
    presentBrowser,
    log,
    socketPath,
    directory,
    clients,
    async connect() {
      const client = await Client.connect(socketPath)
      clients.push(client)
      return client
    },
    async command(...fields: string[]) {
      const client = await created.connect()
      client.send(encodeLine(fields))
      const reply = await client.line()
      await client.waitClosed()
      return reply
    },
  }
  fixtures.push(created)
  return created
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    for (const client of item.clients) client.close()
    await item.service.dispose()
    rmSync(item.directory, { recursive: true, force: true })
  }
})

const text = (field: string | undefined): string => Buffer.from(field ?? '', 'base64').toString('utf8')
const url = (value: string): string[] => ['cmd', 'url', encodeText(value)]

describe.skipIf(process.platform === 'win32')('BotDesktopService lifecycle', () => {
  it('listens on a socket only its owner can use and removes it when disposed', async () => {
    const item = await fixture()
    const info = statSync(item.socketPath)
    expect(info.isSocket()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
    await item.service.dispose()
    expect(existsSync(item.socketPath)).toBe(false)
    await expect(item.service.dispose()).resolves.toBeUndefined()
    await expect(Client.connect(item.socketPath)).rejects.toThrow()
  })

  it('replaces a stale socket file left by a process that was killed', async () => {
    const base = await fixture()
    const socketPath = path.join(base.directory, 'stale.sock')
    const crashed = spawn(
      process.execPath,
      ['-e', "require('node:net').createServer().listen(process.argv[1], () => console.log('listening'))", socketPath],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )
    await new Promise<void>((resolve) => crashed.stdout!.once('data', () => resolve()))
    const exited = new Promise((resolve) => crashed.once('close', resolve))
    crashed.kill('SIGKILL')
    await exited
    expect(statSync(socketPath).isSocket()).toBe(true)
    const service = new BotDesktopService({ ...base.deps, socketPath })
    try {
      await service.start()
      const client = await Client.connect(socketPath)
      client.send(encodeLine(['cmd', 'files']))
      expect(await client.line()).toEqual(['ok'])
      client.close()
    } finally {
      await service.dispose()
    }
  })

  it('does not delete a regular file at the socket path', async () => {
    const base = await fixture()
    const socketPath = path.join(base.directory, 'regular')
    writeFileSync(socketPath, 'precious')
    const service = new BotDesktopService({ ...base.deps, socketPath })
    await expect(service.start()).rejects.toThrow(/not a socket/)
    expect(readFileSync(socketPath, 'utf8')).toBe('precious')
  })

  it('rejects a socket path that does not fit in a Unix socket address', async () => {
    const base = await fixture()
    const long = path.join(base.directory, 'x'.repeat(120), 'desktop.sock')
    const service = new BotDesktopService({ ...base.deps, socketPath: long })
    await expect(service.start()).rejects.toThrow(/too long/)
  })

  it('cannot be started after it was disposed', async () => {
    const base = await fixture()
    const service = new BotDesktopService({ ...base.deps, socketPath: path.join(base.directory, 'again.sock') })
    await service.dispose()
    await expect(service.start()).rejects.toThrow(/disposed/)
  })

  it('closes every connection when disposed', async () => {
    const item = await fixture()
    const idle = await item.connect()
    const pty = item.terminals.add(CONVERSATION)
    const viewer = await item.connect()
    viewer.send(encodeLine(['pty', encodeText(pty.id), '80', '24']))
    expect(await viewer.line()).toEqual(['ok'])
    await item.service.dispose()
    await idle.waitClosed()
    await viewer.waitClosed()
    expect(item.terminals.listeners(pty.id)).toBe(0)
    expect(pty.alive).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('BotDesktopService commands', () => {
  it('refuses a file URL', async () => {
    const item = await fixture()
    const reply = await item.command(...url('file:///etc/passwd'))
    expect(reply[0]).toBe('err')
    expect(text(reply[1])).toBe(MESSAGES.invalidUrl)
    expect(item.openUrl).not.toHaveBeenCalled()
    expect(item.presentBrowser).not.toHaveBeenCalled()
  })

  it.each([
    ['a javascript address', 'javascript:alert(1)'],
    ['an ftp address', 'ftp://example.test/a'],
    ['a data address', 'data:text/html,hi'],
    ['a browser-internal address', 'chrome://settings'],
    ['about:blank', 'about:blank'],
    ['text that is not an address', 'not a url'],
    ['a relative path', '/relative/path'],
    ['an empty address', ''],
    ['an address above the size limit', `https://example.test/${'a'.repeat(DESKTOP_URL_MAX)}`],
  ])('refuses %s', async (_label, value) => {
    const item = await fixture()
    const reply = await item.command(...url(value))
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.invalidUrl])
    expect(item.openUrl).not.toHaveBeenCalled()
  })

  it('opens an http or https URL in the conversation, which brings its browser forward itself', async () => {
    const item = await fixture()
    expect(await item.command(...url('https://example.test/a'))).toEqual(['ok'])
    expect(await item.command(...url('http://example.test/b?q=é'))).toEqual(['ok'])
    // The browser gets the canonical form of the address.
    expect(item.openUrl.mock.calls).toEqual([
      [CONVERSATION, 'https://example.test/a'],
      [CONVERSATION, 'http://example.test/b?q=%C3%A9'],
    ])
    // Presenting would give the browser the keyboard; a link may come from the bot's own programs.
    expect(item.presentBrowser).not.toHaveBeenCalled()
  })

  it('opens a URL of the largest accepted size', async () => {
    const item = await fixture()
    const value = `https://example.test/${'a'.repeat(DESKTOP_URL_MAX - 'https://example.test/'.length)}`
    expect(Buffer.byteLength(value)).toBe(DESKTOP_URL_MAX)
    expect(await item.command(...url(value))).toEqual(['ok'])
    expect(item.openUrl).toHaveBeenCalledWith(CONVERSATION, value)
  })

  it('answers with the reason when the tab cannot be opened', async () => {
    const item = await fixture()
    item.openUrl.mockRejectedValueOnce(new Error('No such conversation'))
    const reply = await item.command(...url('https://example.test/a'))
    expect([reply[0], text(reply[1])]).toEqual(['err', 'No such conversation'])
  })

  it('refuses commands when the bot has no conversation', async () => {
    const item = await fixture({ conversation: null })
    for (const fields of [url('https://example.test/'), ['cmd', 'terminal'], ['cmd', 'browser']]) {
      const reply = await item.command(...fields)
      expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.noConversation])
    }
    expect(item.openUrl).not.toHaveBeenCalled()
    expect(item.terminals.created).toEqual([])
    expect(item.presentBrowser).not.toHaveBeenCalled()
  })

  it('creates a terminal when the conversation has none and shows its viewer', async () => {
    const item = await fixture()
    expect(await item.command('cmd', 'terminal')).toEqual(['ok'])
    expect(item.terminals.created).toEqual([[CONVERSATION, '/home/bot/work']])
    const id = [...item.terminals.ptys.keys()][0]
    expect(item.viewers.show).toHaveBeenCalledExactlyOnceWith(id, `Title of ${id}`)
  })

  it('shows the newest terminal of the conversation when there are some', async () => {
    const item = await fixture()
    item.terminals.add(CONVERSATION, 'term:old')
    item.terminals.add(OTHER_CONVERSATION, 'term:foreign')
    item.terminals.add(CONVERSATION, 'term:new')
    expect(await item.command('cmd', 'terminal')).toEqual(['ok'])
    expect(item.terminals.created).toEqual([])
    expect(item.viewers.show).toHaveBeenCalledExactlyOnceWith('term:new', 'Title of term:new')
  })

  it('ignores terminals that already ended', async () => {
    const item = await fixture()
    item.terminals.add(CONVERSATION, 'term:live')
    item.terminals.add(CONVERSATION, 'term:ended').alive = false
    expect(item.terminals.list(CONVERSATION).map((terminal) => terminal.id)).toEqual(['term:live', 'term:ended'])
    expect(await item.command('cmd', 'terminal')).toEqual(['ok'])
    expect(item.viewers.show).toHaveBeenCalledWith('term:live', expect.any(String))
  })

  it('creates a single terminal for simultaneous requests', async () => {
    const item = await fixture()
    const replies = await Promise.all([
      item.command('cmd', 'terminal'),
      item.command('cmd', 'terminal'),
      item.command('cmd', 'terminal'),
    ])
    expect(replies).toEqual([['ok'], ['ok'], ['ok']])
    expect(item.terminals.created).toHaveLength(1)
    expect(item.viewers.show).toHaveBeenCalledTimes(3)
  })

  it('answers with the terminal message when a terminal cannot be created or shown', async () => {
    const item = await fixture()
    item.terminals.createFailure = 'cwd-locked'
    let reply = await item.command('cmd', 'terminal')
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.terminalFailed])
    expect(item.log).toHaveBeenCalledWith(expect.stringContaining('cwd-locked'))
    item.terminals.createFailure = null
    item.viewers.show.mockRejectedValueOnce(new Error('Too many terminal windows'))
    reply = await item.command('cmd', 'terminal')
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.terminalFailed])
    expect(item.log).toHaveBeenCalledWith(expect.stringContaining('Too many terminal windows'))
  })

  it('refuses to create a terminal without a working folder', async () => {
    const item = await fixture({ cwd: null })
    const reply = await item.command('cmd', 'terminal')
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.terminalFailed])
    expect(item.terminals.created).toEqual([])
  })

  it('opens the file manager', async () => {
    const item = await fixture()
    expect(await item.command('cmd', 'files')).toEqual(['ok'])
    expect(item.openFiles).toHaveBeenCalledTimes(1)
    item.openFiles.mockRejectedValueOnce(new Error('pcmanfm is not installed'))
    const reply = await item.command('cmd', 'files')
    expect([reply[0], text(reply[1])]).toEqual(['err', 'pcmanfm is not installed'])
  })

  it('shows the browser of the conversation', async () => {
    const item = await fixture()
    expect(await item.command('cmd', 'browser')).toEqual(['ok'])
    expect(item.presentBrowser).toHaveBeenCalledExactlyOnceWith(CONVERSATION)
    expect(item.openUrl).not.toHaveBeenCalled()
  })

  it('tells why the browser cannot be shown, whatever the failure looks like', async () => {
    const item = await fixture()
    item.presentBrowser.mockRejectedValueOnce(new Error('Presenter offline'))
    let reply = await item.command('cmd', 'browser')
    expect([reply[0], text(reply[1])]).toEqual(['err', 'Presenter offline'])
    item.presentBrowser.mockRejectedValueOnce('boom')
    reply = await item.command('cmd', 'browser')
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.presenterUnavailable])
  })

  it('does not stop a bot from using the socket after a command failed unexpectedly', async () => {
    const item = await fixture()
    item.openFiles.mockImplementationOnce(() => {
      throw new Error('sync failure')
    })
    const reply = await item.command('cmd', 'files')
    expect([reply[0], text(reply[1])]).toEqual(['err', 'sync failure'])
    expect(await item.command('cmd', 'files')).toEqual(['ok'])
  })

  it('serves one command per connection and ignores what follows it', async () => {
    const item = await fixture()
    const client = await item.connect()
    client.send(
      Buffer.concat([encodeLine(['cmd', 'files']), encodeLine(['cmd', 'files']), encodeLine(['cmd', 'terminal'])])
    )
    expect(await client.line()).toEqual(['ok'])
    await client.waitClosed()
    expect(item.openFiles).toHaveBeenCalledTimes(1)
    expect(item.terminals.created).toEqual([])
  })

  it('serves a client that closes its sending side after the command', async () => {
    const item = await fixture()
    const client = await item.connect()
    client.socket.end(encodeLine(['cmd', 'files']))
    expect(await client.line()).toEqual(['ok'])
  })
})

describe.skipIf(process.platform === 'win32')('BotDesktopService malformed clients', () => {
  async function refused(item: Fixture, data: Buffer | string): Promise<string[]> {
    const client = await item.connect()
    client.send(data)
    const reply = await client.line()
    await client.waitClosed()
    return reply
  }

  it('refuses an unknown role', async () => {
    const item = await fixture()
    const reply = await refused(item, 'admin\tnow\n')
    expect(reply[0]).toBe('err')
    expect(text(reply[1])).not.toBe('')
  })

  it('refuses invalid base64 and unknown commands', async () => {
    const item = await fixture()
    expect((await refused(item, 'cmd\turl\t%%%\n'))[0]).toBe('err')
    expect((await refused(item, 'cmd\treboot\n'))[0]).toBe('err')
    expect((await refused(item, 'cmd\tterminal\textra\n'))[0]).toBe('err')
    expect((await refused(item, 'pty\t!!\t80\t24\n'))[0]).toBe('err')
    expect((await refused(item, 'pty\tdGVybQ==\t0\t24\n'))[0]).toBe('err')
    expect((await refused(item, '\n'))[0]).toBe('err')
    expect(item.openUrl).not.toHaveBeenCalled()
    expect(item.openFiles).not.toHaveBeenCalled()
  })

  it('refuses a line above the size limit and keeps serving', async () => {
    const item = await fixture()
    const client = await item.connect()
    client.send(Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61))
    expect((await client.line())[0]).toBe('err')
    await client.waitClosed()
    expect(await item.command('cmd', 'files')).toEqual(['ok'])
  })

  it('closes a connection that never sends its role', async () => {
    const item = await fixture({ handshakeTimeoutMs: 40 })
    const silent = await item.connect()
    const partial = await item.connect()
    partial.send('cmd\tfil')
    await silent.waitClosed()
    await partial.waitClosed()
    expect(item.openFiles).not.toHaveBeenCalled()
  })

  it('does not apply the handshake timeout to a command that is still running', async () => {
    const item = await fixture({ handshakeTimeoutMs: 40 })
    let release: () => void = () => {}
    item.openFiles.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const client = await item.connect()
    client.send(encodeLine(['cmd', 'files']))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(client.closed).toBe(false)
    release()
    expect(await client.line()).toEqual(['ok'])
  })

  it('survives clients that disconnect in the middle of a request', async () => {
    const item = await fixture()
    const half = await item.connect()
    half.send('cmd\tfi')
    half.close()
    const gone = await item.connect()
    gone.send(encodeLine(['cmd', 'files']))
    gone.close()
    await vi.waitFor(() => expect(item.openFiles).toHaveBeenCalled())
    expect(await item.command('cmd', 'files')).toEqual(['ok'])
  })

  it('closes a pty connection that sends an unknown frame and leaves the pty running', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const client = await item.connect()
    client.send(encodeLine(['pty', encodeText(pty.id), '80', '24']))
    expect(await client.line()).toEqual(['ok'])
    client.send(Buffer.from([9, 0, 0, 0, 0]))
    await client.waitClosed()
    expect(pty.alive).toBe(true)
    expect(item.terminals.listeners(pty.id)).toBe(0)
    expect(item.terminals.writes).toEqual([])
  })

  it('closes a pty connection that sends a frame the server only sends, or a bad size', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    for (const bad of [encodeFrame(FRAME.exit, exitPayload(0, 'x')), encodeFrame(FRAME.size, Buffer.alloc(2))]) {
      const client = await item.connect()
      client.send(encodeLine(['pty', encodeText(pty.id), '80', '24']))
      expect(await client.line()).toEqual(['ok'])
      client.send(bad)
      await client.waitClosed()
    }
    expect(item.terminals.resizes.filter((entry) => entry[1] !== 80)).toEqual([])
    expect(item.terminals.listeners(pty.id)).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32')('BotDesktopService terminal connections', () => {
  async function attach(item: Fixture, id: string, size: [number, number] = [80, 24]): Promise<Client> {
    const client = await item.connect()
    client.send(encodeLine(['pty', encodeText(id), String(size[0]), String(size[1])]))
    return client
  }

  it('refuses a pty of another conversation', async () => {
    const item = await fixture()
    const foreign = item.terminals.add(OTHER_CONVERSATION)
    const client = await attach(item, foreign.id)
    const reply = await client.line()
    expect(reply[0]).toBe('err')
    expect(text(reply[1])).toBe(MESSAGES.terminalFailed)
    await client.waitClosed()
    expect(item.terminals.listeners(foreign.id)).toBe(0)
    expect(item.terminals.resizes).toEqual([])
  })

  it('refuses unknown and ended ptys and a bot without a conversation', async () => {
    const item = await fixture()
    const ended = item.terminals.add(CONVERSATION)
    ended.alive = false
    for (const id of ['term:none', ended.id]) {
      const client = await attach(item, id)
      expect((await client.line())[0]).toBe('err')
      await client.waitClosed()
    }
    const idle = await fixture({ conversation: null })
    const client = await attach(idle, 'term:any')
    const reply = await client.line()
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.noConversation])
  })

  it('sends the current snapshot and then the live output', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:one', 'history\r\n')
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    await client.output('history\r\n')
    item.terminals.emit(pty.id, 'live-1 ')
    item.terminals.emit(pty.id, 'live-2')
    await client.output('live-1 live-2')
    await client.noMoreFrames()
  })

  it('sends nothing for an empty snapshot', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    await client.noMoreFrames()
    item.terminals.emit(pty.id, 'first')
    await client.output('first')
  })

  it('does not repeat output that is both in the snapshot and in a notification', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:race', 'A')
    // "B" arrives after the subscription and before the snapshot: the snapshot holds it, and so does the notification.
    item.terminals.beforeSnapshot = (id) => {
      item.terminals.beforeSnapshot = null
      item.terminals.emit(id, 'B')
    }
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    await client.output('AB')
    item.terminals.emit(pty.id, 'C')
    await client.output('C')
    await client.noMoreFrames()
  })

  it('resets the screen when the shell behind the id was replaced', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:restart', 'old shell')
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    await client.output('old shell')
    item.terminals.restart(pty.id)
    item.terminals.emit(pty.id, 'new shell')
    await client.output('\x1bcnew shell')
    item.terminals.emit(pty.id, '!')
    await client.output('!')
  })

  it('applies the size from the handshake and the sizes sent later', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const client = await attach(item, pty.id, [132, 43])
    expect(await client.line()).toEqual(['ok'])
    await vi.waitFor(() => expect(item.terminals.resizes).toEqual([[pty.id, 132, 43]]))
    client.send(encodeFrame(FRAME.size, sizePayload(100, 30)))
    await vi.waitFor(() => expect(item.terminals.resizes.at(-1)).toEqual([pty.id, 100, 30]))
  })

  it('writes what the client types into the pty, including characters split between frames', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    const bytes = Buffer.from('ls é\r', 'utf8')
    client.send(encodeFrame(FRAME.data, bytes.subarray(0, 4)))
    client.send(encodeFrame(FRAME.data, bytes.subarray(4)))
    await vi.waitFor(() => expect(item.terminals.writes.map((entry) => entry[1]).join('')).toBe('ls é\r'))
    expect(item.terminals.writes.every((entry) => entry[0] === pty.id)).toBe(true)
  })

  it('accepts a request that brings the handshake and the first frames in one chunk', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:fast', 'x')
    const client = await item.connect()
    client.send(
      Buffer.concat([
        encodeLine(['pty', encodeText(pty.id), '80', '24']),
        encodeFrame(FRAME.data, Buffer.from('a\nb\n')),
        encodeFrame(FRAME.size, sizePayload(90, 20)),
      ])
    )
    expect(await client.line()).toEqual(['ok'])
    await vi.waitFor(() => expect(item.terminals.writes).toEqual([[pty.id, 'a\nb\n']]))
    await vi.waitFor(() => expect(item.terminals.resizes.at(-1)).toEqual([pty.id, 90, 20]))
  })

  it('leaves the pty running when the client goes away, and lets another client attach', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:keep', 'hello')
    const first = await attach(item, pty.id)
    expect(await first.line()).toEqual(['ok'])
    await first.output('hello')
    expect(item.terminals.listeners(pty.id)).toBe(2)
    first.close()
    await vi.waitFor(() => expect(item.terminals.listeners(pty.id)).toBe(0))
    expect(pty.alive).toBe(true)
    item.terminals.emit(pty.id, ' more')
    const second = await attach(item, pty.id)
    expect(await second.line()).toEqual(['ok'])
    await second.output('hello more')
  })

  it('serves several clients of the same pty', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const first = await attach(item, pty.id)
    const second = await attach(item, pty.id)
    expect(await first.line()).toEqual(['ok'])
    expect(await second.line()).toEqual(['ok'])
    item.terminals.emit(pty.id, 'both')
    await first.output('both')
    await second.output('both')
  })

  it('reports the exit code with its message and closes the connection', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:exit', 'bye')
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    await client.frames(1)
    item.terminals.exit(pty.id, 3)
    const [frame] = await client.frames(1)
    expect(frame.type).toBe(FRAME.exit)
    expect(parseExitPayload(frame.payload)).toEqual({ code: 3, message: MESSAGES.exit(3) })
    await client.waitClosed()
    expect(item.terminals.listeners(pty.id)).toBe(0)
  })

  it('delivers the output that comes before the exit', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const client = await attach(item, pty.id)
    expect(await client.line()).toEqual(['ok'])
    item.terminals.emit(pty.id, 'last words')
    item.terminals.exit(pty.id, 0)
    const frames = await client.frames(2)
    expect(frames.map((frame) => frame.type)).toEqual([FRAME.data, FRAME.exit])
    expect(frames[0].payload.toString()).toBe('last words')
  })

  it('drops a client that cannot keep up and keeps the pty', async () => {
    const item = await fixture({ maxQueuedBytes: 512 * 1024 })
    const pty = item.terminals.add(CONVERSATION)
    const slow = await attach(item, pty.id)
    expect(await slow.line()).toEqual(['ok'])
    slow.socket.pause()
    const chunk = 'x'.repeat(256 * 1024)
    for (let index = 0; index < 64 && item.terminals.listeners(pty.id) > 0; index++) item.terminals.emit(pty.id, chunk)
    expect(item.terminals.listeners(pty.id)).toBe(0)
    expect(pty.alive).toBe(true)
    expect(item.log).toHaveBeenCalledWith(expect.stringContaining('queue'))
    // A viewer that keeps up is not affected.
    const fast = await attach(item, pty.id)
    expect(await fast.line()).toEqual(['ok'])
    expect(item.terminals.listeners(pty.id)).toBe(2)
  })
})

describe.skipIf(process.platform === 'win32')('BotDesktopService presenter connections', () => {
  it('answers err when no presenter handler is attached', async () => {
    const item = await fixture()
    const client = await item.connect()
    client.send(encodeLine(['presenter', '1']))
    const reply = await client.line()
    expect([reply[0], text(reply[1])]).toEqual(['err', MESSAGES.presenterUnavailable])
    await client.waitClosed()
  })

  it('hands the connection to the presenter after replying ok', async () => {
    const links: PresenterLink[] = []
    const received: string[][] = []
    const closed = vi.fn()
    const item = await fixture({
      attachPresenter: (link) => {
        links.push(link)
        link.onLine((fields) => received.push(fields))
        link.onClose(closed)
      },
    })
    const client = await item.connect()
    // The first lines of the presenter arrive in the same chunk as its role line.
    client.send(Buffer.concat([encodeLine(['presenter', '1']), encodeLine(['hello', 'one'])]))
    expect(await client.line()).toEqual(['ok'])
    await vi.waitFor(() => expect(received).toEqual([['hello', 'one']]))
    client.send(encodeLine(['hello', 'two']))
    await vi.waitFor(() =>
      expect(received).toEqual([
        ['hello', 'one'],
        ['hello', 'two'],
      ])
    )
    links[0].send(['rect', '1', '2'])
    expect(await client.line()).toEqual(['rect', '1', '2'])
    client.close()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1))
  })

  it('lets the presenter close its connection and closes it for a line above the limit', async () => {
    const links: PresenterLink[] = []
    const closed = vi.fn()
    const item = await fixture({
      attachPresenter: (link) => {
        links.push(link)
        link.onClose(closed)
      },
    })
    const first = await item.connect()
    first.send(encodeLine(['presenter', '1']))
    expect(await first.line()).toEqual(['ok'])
    links[0].close()
    await first.waitClosed()
    const second = await item.connect()
    second.send(encodeLine(['presenter', '1']))
    expect(await second.line()).toEqual(['ok'])
    second.send(Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61))
    await second.waitClosed()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(2))
  })

  it('does not let a failing presenter handler crash the service', async () => {
    const item = await fixture({
      attachPresenter: () => {
        throw new Error('presenter handler failed')
      },
    })
    const client = await item.connect()
    client.send(encodeLine(['presenter', '1']))
    await client.waitClosed()
    expect(item.log).toHaveBeenCalledWith(expect.stringContaining('presenter handler failed'))
    expect(await item.command('cmd', 'files')).toEqual(['ok'])
  })
})

const BIN = fileURLToPath(new URL('../../../../deploy/bot-fleet/desktop/bin/', import.meta.url))

interface ScriptRun {
  child: ChildProcess
  stdout(): string
  stderr(): string
  exit: Promise<number | null>
}

function runScript(name: string, args: string[], env: Record<string, string | undefined>): ScriptRun {
  const child = spawn(process.execPath, [path.join(BIN, name), ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const exit = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
  return { child, stdout: () => stdout, stderr: () => stderr, exit }
}

describe.skipIf(process.platform === 'win32')('maestrly-desktop', () => {
  it('sends commands to the socket of the bot', async () => {
    const item = await fixture()
    const env = { MAESTRLY_DESKTOP_SOCKET: item.socketPath }
    expect(await runScript('maestrly-desktop', ['files'], env).exit).toBe(0)
    expect(await runScript('maestrly-desktop', ['terminal'], env).exit).toBe(0)
    expect(await runScript('maestrly-desktop', ['browser'], env).exit).toBe(0)
    expect(await runScript('maestrly-desktop', ['url', 'https://example.test/é?a=1&b=2'], env).exit).toBe(0)
    expect(item.openFiles).toHaveBeenCalledTimes(1)
    expect(item.viewers.show).toHaveBeenCalledTimes(1)
    expect(item.presentBrowser).toHaveBeenCalledTimes(1)
    expect(item.openUrl).toHaveBeenCalledExactlyOnceWith(CONVERSATION, 'https://example.test/%C3%A9?a=1&b=2')
  })

  it('prints the decoded error and exits with 1 when the service refuses', async () => {
    const item = await fixture()
    const run = runScript('maestrly-desktop', ['url', 'file:///etc/passwd'], {
      MAESTRLY_DESKTOP_SOCKET: item.socketPath,
    })
    expect(await run.exit).toBe(1)
    expect(run.stderr()).toContain(MESSAGES.invalidUrl)
    expect(run.stdout()).toBe('')
    expect(item.openUrl).not.toHaveBeenCalled()
  })

  it('explains the usage and the missing socket', async () => {
    const item = await fixture()
    const env = { MAESTRLY_DESKTOP_SOCKET: item.socketPath }
    for (const args of [[], ['reboot'], ['url'], ['files', 'extra'], ['url', 'a', 'b']]) {
      const run = runScript('maestrly-desktop', args, env)
      const code = await run.exit
      expect(code, args.join(' ')).not.toBe(0)
      expect(run.stderr(), args.join(' ')).toMatch(/usage/i)
    }
    const noEnv = runScript('maestrly-desktop', ['files'], {})
    expect(await noEnv.exit).not.toBe(0)
    expect(noEnv.stderr()).toContain('MAESTRLY_DESKTOP_SOCKET')
    const noSocket = runScript('maestrly-desktop', ['files'], {
      MAESTRLY_DESKTOP_SOCKET: path.join(item.directory, 'missing.sock'),
    })
    expect(await noSocket.exit).toBe(1)
    expect(noSocket.stderr()).not.toBe('')
  })

  it('is executable and starts with a Node shebang', () => {
    for (const name of ['maestrly-desktop', 'maestrly-pty-attach']) {
      const file = path.join(BIN, name)
      expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('#!/usr/local/bin/node')
      expect(readFileSync(file, 'utf8')).not.toContain('\r')
      expect(statSync(file).mode & 0o111).toBe(0o111)
    }
    const wrapper = readFileSync(path.join(BIN, 'maestrly-open-url'), 'utf8')
    expect(wrapper.split('\n')[0]).toBe('#!/bin/sh')
    expect(wrapper).toContain('exec /usr/local/bin/maestrly-desktop url "$1"')
    expect(statSync(path.join(BIN, 'maestrly-open-url')).mode & 0o111).toBe(0o111)
  })
})

describe.skipIf(process.platform === 'win32')('maestrly-pty-attach', () => {
  it('shows the snapshot and the live output, forwards typing and reports the exit', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION, 'term:attach', 'prompt$ ')
    const run = runScript('maestrly-pty-attach', [], {
      MAESTRLY_DESKTOP_SOCKET: item.socketPath,
      MAESTRLY_PTY_ID: pty.id,
    })
    await vi.waitFor(() => expect(run.stdout()).toBe('prompt$ '))
    // Stdin is a pipe here, so the client has no terminal size and asks for the default.
    await vi.waitFor(() => expect(item.terminals.resizes).toEqual([[pty.id, 80, 24]]))
    item.terminals.emit(pty.id, 'ls\r\n')
    await vi.waitFor(() => expect(run.stdout()).toBe('prompt$ ls\r\n'))
    run.child.stdin!.write('echo é\r')
    await vi.waitFor(() => expect(item.terminals.writes).toEqual([[pty.id, 'echo é\r']]))
    item.terminals.exit(pty.id, 4)
    expect(await run.exit).toBe(4)
    expect(run.stdout()).toContain(MESSAGES.exit(4))
    expect(pty.alive).toBe(false)
  })

  it('leaves the pty running when it is stopped, and exits when the socket closes', async () => {
    const item = await fixture()
    const pty = item.terminals.add(CONVERSATION)
    const run = runScript('maestrly-pty-attach', [], {
      MAESTRLY_DESKTOP_SOCKET: item.socketPath,
      MAESTRLY_PTY_ID: pty.id,
    })
    await vi.waitFor(() => expect(item.terminals.listeners(pty.id)).toBe(2))
    run.child.kill('SIGTERM')
    await run.exit
    await vi.waitFor(() => expect(item.terminals.listeners(pty.id)).toBe(0))
    expect(pty.alive).toBe(true)

    const second = runScript('maestrly-pty-attach', [], {
      MAESTRLY_DESKTOP_SOCKET: item.socketPath,
      MAESTRLY_PTY_ID: pty.id,
    })
    await vi.waitFor(() => expect(item.terminals.listeners(pty.id)).toBe(2))
    await item.service.dispose()
    expect(await second.exit).not.toBeNull()
  })

  it('prints the reason when the service refuses the pty', async () => {
    const item = await fixture()
    const foreign = item.terminals.add(OTHER_CONVERSATION)
    const run = runScript('maestrly-pty-attach', [], {
      MAESTRLY_DESKTOP_SOCKET: item.socketPath,
      MAESTRLY_PTY_ID: foreign.id,
    })
    expect(await run.exit).toBe(1)
    expect(run.stderr()).toContain(MESSAGES.terminalFailed)
  })

  it('needs its environment', async () => {
    const item = await fixture()
    const noPty = runScript('maestrly-pty-attach', [], { MAESTRLY_DESKTOP_SOCKET: item.socketPath })
    expect(await noPty.exit).not.toBe(0)
    expect(noPty.stderr()).toContain('MAESTRLY_PTY_ID')
    const noSocket = runScript('maestrly-pty-attach', [], { MAESTRLY_PTY_ID: 'term:x' })
    expect(await noSocket.exit).not.toBe(0)
    expect(noSocket.stderr()).toContain('MAESTRLY_DESKTOP_SOCKET')
    const missing = runScript('maestrly-pty-attach', [], {
      MAESTRLY_DESKTOP_SOCKET: path.join(item.directory, 'missing.sock'),
      MAESTRLY_PTY_ID: 'term:x',
    })
    expect(await missing.exit).toBe(1)
    expect(missing.stderr()).not.toBe('')
  })
})
