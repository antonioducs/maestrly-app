import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  DesktopProtocolError,
  type DesktopRole,
  FRAME,
  FrameReader,
  LineReader,
  encodeFrame,
  encodeLine,
  encodeText,
  exitPayload,
  parseRoleLine,
  parseSizePayload,
} from './socket-protocol'

/**
 * The per-bot desktop service: the Unix socket the dock launchers and programs on a bot's display use to reach the
 * Electron main process. It never trusts the client: every request is validated, a connection gets one role, and a
 * broken connection is closed with a log line and nothing else. One service exists per bot screen, created with it
 * and disposed with it. The wire format lives in `socket-protocol.ts`.
 */

/** The longest URL, in bytes, the `url` command accepts. */
export const DESKTOP_URL_MAX = 8 * 1024

/** The shells of the bot's conversation, as the service needs them. */
export interface DesktopTerminals {
  /** The terminals of the conversation, oldest first. May include terminals that already ended. */
  list(conversationId: string): Array<{ id: string }>
  create(conversationId: string, cwd: string): { ok: true; id: string } | { ok: false; reason: string }
  belongsTo(conversationId: string, id: string): boolean
  /** Whether the terminal's process is running. */
  exists(id: string): boolean
  snapshot(id: string): { data: string; generation: number; sequence: number }
  write(id: string, data: string): boolean
  resize(id: string, cols: number, rows: number): void
  onOutput(id: string, listener: (data: string, meta: { generation: number; sequence: number }) => void): () => void
  onExit(id: string, listener: (code: number) => void): () => void
  title(id: string): string
}

/** The connection of the browser presenter, once the service accepted it. Lines have the format of the handshake. */
export interface PresenterLink {
  /** Throws when a field holds a tab or a newline. A link that is closed or too slow ignores the line. */
  send(fields: readonly string[]): void
  onLine(listener: (fields: string[]) => void): void
  /** Runs once when the connection ends for any reason. */
  onClose(listener: () => void): void
  close(): void
}

export interface BotDesktopServiceDeps {
  /** At most 107 bytes. */
  socketPath: string
  /** The conversation the bot is working on, or `null` when it has none. */
  conversationId(): string | null
  conversationCwd(conversationId: string): string | null
  terminals: DesktopTerminals
  viewers: { show(ptyId: string, title: string): Promise<void> }
  openFiles(): Promise<void>
  /** Opens the address in a tab of the conversation's browser. A rejection's message goes back to the client. */
  openUrl(conversationId: string, url: string): Promise<void>
  /** Shows the bot's browser window on its desktop. A rejection's message goes back to the client. */
  presentBrowser(conversationId: string): Promise<void>
  /** Takes over a `presenter 1` connection after the service replied `ok`; absent: the service replies `err`. */
  attachPresenter?(link: PresenterLink): void
  messages: {
    presenterUnavailable: string
    noConversation: string
    invalidUrl: string
    terminalFailed: string
    exit(code: number): string
  }
  log(message: string): void
  /** How long a connection may take to send its first line. Defaults to 10 s. */
  handshakeTimeoutMs?: number
  /** The most bytes the service queues for one connection before it drops the connection. Defaults to 4 MiB. */
  maxQueuedBytes?: number
}

type ConnectionState = 'handshake' | 'command' | 'pty' | 'presenter' | 'closing' | 'closed'
type Timer = ReturnType<typeof setTimeout>

interface Connection {
  readonly socket: net.Socket
  state: ConnectionState
  readonly lines: LineReader
  frames: FrameReader | null
  ptyId: string | null
  input: StringDecoder | null
  timer: Timer | null
  /** Cancels subscriptions to the terminal; run once when the connection stops needing them. */
  releases: Array<() => void>
  lineListeners: Array<(fields: string[]) => void>
  closeListeners: Array<() => void>
}

/** Linux keeps 108 bytes for a socket path, including the terminating NUL. */
const SOCKET_PATH_MAX = 107
const HANDSHAKE_TIMEOUT_MS = 10_000
const QUEUED_BYTES_MAX = 4 * 1024 * 1024
const CONNECTIONS_MAX = 64
/** After the service answers with an error or the exit, a client that does not hang up is dropped after this. */
const LINGER_MS = 1_000
const OUTPUT_FRAME_BYTES = 256 * 1024
/** Clears the screen when the shell behind a terminal id was replaced while a viewer was attached. */
const TERMINAL_RESET = '\x1bc'

/** A refusal whose message is meant for the person using the bot's desktop. */
class Refusal extends Error {}

function reasonOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

/** Binds with owner-only permissions from the first instant, so no other user can connect before the chmod. */
function listenPrivately(server: net.Server, socketPath: string, onListening: () => void): void {
  let previous: number | null = null
  try {
    previous = process.umask(0o177)
  } catch {
    // Worker threads cannot change the mask; the chmod after listening and the folder mode still apply.
  }
  try {
    server.listen(socketPath, onListening)
  } finally {
    if (previous !== null) process.umask(previous)
  }
}

export class BotDesktopService {
  private readonly connections = new Set<Connection>()
  private readonly handshakeMs: number
  private readonly queuedMax: number
  private server: net.Server | null = null
  private bound = false
  private state: 'new' | 'starting' | 'running' | 'disposed' = 'new'
  private disposal: Promise<void> | null = null

  constructor(private readonly deps: BotDesktopServiceDeps) {
    this.handshakeMs = deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    this.queuedMax = deps.maxQueuedBytes ?? QUEUED_BYTES_MAX
  }

  /** Removes a stale socket file, listens and restricts the socket to its owner. */
  async start(): Promise<void> {
    if (this.state === 'disposed') throw new Error('The desktop service was disposed')
    if (this.state !== 'new') throw new Error('The desktop service was already started')
    const socketPath = this.deps.socketPath
    const bytes = Buffer.byteLength(socketPath)
    if (bytes > SOCKET_PATH_MAX) {
      throw new RangeError(
        `The desktop socket path is too long (${bytes} bytes, the limit is ${SOCKET_PATH_MAX}): ${socketPath}`
      )
    }
    this.state = 'starting'
    try {
      await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 })
      await this.removeStaleSocket(socketPath)
      this.assertNotDisposed()
      const server = net.createServer({ allowHalfOpen: true }, (socket) => this.accept(socket))
      server.maxConnections = CONNECTIONS_MAX
      this.server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        listenPrivately(server, socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      this.bound = true
      server.on('error', (error) => this.deps.log(`The desktop socket server failed: ${error.message}`))
      await chmod(socketPath, 0o600)
      this.assertNotDisposed()
      this.state = 'running'
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  /** Closes the socket and every connection, and removes the socket file. Safe to call more than once. */
  dispose(): Promise<void> {
    this.disposal ??= this.shutDown()
    return this.disposal
  }

  private assertNotDisposed(): void {
    if (this.state === 'disposed') throw new Error('The desktop service was disposed')
  }

  private async removeStaleSocket(socketPath: string): Promise<void> {
    let info: Stats
    try {
      info = await lstat(socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!info.isSocket()) throw new Error(`${socketPath} exists and is not a socket`)
    await unlink(socketPath)
  }

  private async shutDown(): Promise<void> {
    this.state = 'disposed'
    for (const connection of [...this.connections]) this.close(connection)
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => {
        if (!server.listening) resolve()
        else server.close(() => resolve())
      })
    }
    if (this.bound) {
      this.bound = false
      try {
        await unlink(this.deps.socketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.deps.log(`Removing the desktop socket failed: ${(error as Error).message}`)
        }
      }
    }
  }

  private accept(socket: net.Socket): void {
    if (this.state === 'disposed') {
      socket.destroy()
      return
    }
    const connection: Connection = {
      socket,
      state: 'handshake',
      lines: new LineReader(),
      frames: null,
      ptyId: null,
      input: null,
      timer: null,
      releases: [],
      lineListeners: [],
      closeListeners: [],
    }
    this.connections.add(connection)
    this.startTimer(connection, this.handshakeMs, () => {
      this.deps.log('Closed a desktop connection that sent no request in time')
      this.close(connection)
    })
    socket.on('data', (chunk) => this.receive(connection, chunk))
    socket.on('end', () => this.ended(connection))
    socket.on('error', (error) => {
      this.deps.log(`A desktop connection failed: ${error.message}`)
      this.close(connection)
    })
    socket.on('close', () => this.close(connection))
  }

  private startTimer(connection: Connection, ms: number, onTimeout: () => void): void {
    this.clearTimer(connection)
    connection.timer = setTimeout(onTimeout, ms)
    connection.timer.unref()
  }

  private clearTimer(connection: Connection): void {
    if (connection.timer) clearTimeout(connection.timer)
    connection.timer = null
  }

  private release(connection: Connection): void {
    const releases = connection.releases.splice(0)
    for (const release of releases) release()
  }

  /** Ends the connection now and for good: stops listening to the terminal and tells a presenter it is gone. */
  private close(connection: Connection): void {
    if (connection.state === 'closed') return
    const wasPresenter = connection.state === 'presenter'
    connection.state = 'closed'
    this.clearTimer(connection)
    this.release(connection)
    this.connections.delete(connection)
    connection.socket.destroy()
    if (wasPresenter) {
      for (const listener of connection.closeListeners.splice(0)) {
        try {
          listener()
        } catch (error) {
          this.deps.log(`A presenter close listener failed: ${reasonOf(error, 'unknown error')}`)
        }
      }
    }
  }

  /** Sends the last words of the service on a connection, then lets the client hang up (or drops it soon). */
  private finish(connection: Connection, last?: Buffer): void {
    if (connection.state === 'closing' || connection.state === 'closed') return
    connection.state = 'closing'
    this.release(connection)
    this.startTimer(connection, LINGER_MS, () => this.close(connection))
    if (last) connection.socket.end(last)
    else connection.socket.end()
  }

  private replyError(connection: Connection, message: string): void {
    this.finish(connection, encodeLine(['err', encodeText(message)]))
  }

  private ended(connection: Connection): void {
    // A command client may hang up its sending side and still wait for the answer.
    if (connection.state === 'command' || connection.state === 'closing') return
    this.close(connection)
  }

  private receive(connection: Connection, chunk: Buffer): void {
    try {
      switch (connection.state) {
        case 'handshake':
          this.handshake(connection, chunk)
          break
        case 'pty':
          this.ptyInput(connection, chunk)
          break
        case 'presenter':
          this.presenterInput(connection, chunk)
          break
        default:
          // One command per connection, and nothing is read from a connection that is closing.
          break
      }
    } catch (error) {
      this.deps.log(`A desktop connection was refused: ${reasonOf(error, 'unknown error')}`)
      if (connection.state === 'handshake') {
        this.replyError(connection, error instanceof DesktopProtocolError ? error.message : 'Internal error')
      } else this.close(connection)
    }
  }

  private handshake(connection: Connection, chunk: Buffer): void {
    // Only the first line: what follows a `pty` role is binary and must not be cut into lines.
    const [first] = connection.lines.push(chunk, 1)
    if (!first) return
    const role = parseRoleLine(first)
    this.clearTimer(connection)
    switch (role.role) {
      case 'cmd':
        connection.state = 'command'
        void this.runCommand(connection, role)
        break
      case 'pty':
        this.startPty(connection, role)
        break
      case 'presenter':
        this.startPresenter(connection)
        break
    }
  }

  // --- Commands ---

  private async runCommand(connection: Connection, role: Extract<DesktopRole, { role: 'cmd' }>): Promise<void> {
    try {
      await this.execute(role)
      if (connection.state === 'command') this.finish(connection, encodeLine(['ok']))
    } catch (error) {
      if (!(error instanceof Refusal))
        this.deps.log(`The ${role.command} command failed: ${reasonOf(error, 'unknown')}`)
      if (connection.state === 'command') {
        this.replyError(connection, reasonOf(error, 'The command failed'))
      }
    }
  }

  private async execute(role: Extract<DesktopRole, { role: 'cmd' }>): Promise<void> {
    switch (role.command) {
      case 'files':
        await this.deps.openFiles()
        return
      case 'url': {
        const url = this.checkedUrl(role.argument ?? '')
        const conversationId = this.requireConversation()
        await this.deps.openUrl(conversationId, url)
        await this.presentBrowser(conversationId)
        return
      }
      case 'browser':
        await this.presentBrowser(this.requireConversation())
        return
      case 'terminal':
        await this.showTerminal()
        return
    }
  }

  private async presentBrowser(conversationId: string): Promise<void> {
    try {
      await this.deps.presentBrowser(conversationId)
    } catch (error) {
      throw new Refusal(reasonOf(error, this.deps.messages.presenterUnavailable))
    }
  }

  private requireConversation(): string {
    const conversationId = this.deps.conversationId()
    if (!conversationId) throw new Refusal(this.deps.messages.noConversation)
    return conversationId
  }

  /** Only http and https addresses of a sane size reach the browser. Returns the address in canonical form. */
  private checkedUrl(value: string): string {
    const refusal = new Refusal(this.deps.messages.invalidUrl)
    if (value === '' || Buffer.byteLength(value) > DESKTOP_URL_MAX) throw refusal
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw refusal
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refusal
    return url.href
  }

  private async showTerminal(): Promise<void> {
    const { terminals, messages } = this.deps
    const conversationId = this.requireConversation()
    // The list can still hold terminals that ended; the newest one that runs is the one to show.
    let id = terminals
      .list(conversationId)
      .filter((terminal) => terminals.exists(terminal.id))
      .at(-1)?.id
    if (!id) {
      const cwd = this.deps.conversationCwd(conversationId)
      if (!cwd) {
        this.deps.log('No working folder to start a terminal in')
        throw new Refusal(messages.terminalFailed)
      }
      const created = terminals.create(conversationId, cwd)
      if (!created.ok) {
        this.deps.log(`Creating a terminal failed: ${created.reason}`)
        throw new Refusal(messages.terminalFailed)
      }
      id = created.id
    }
    try {
      await this.deps.viewers.show(id, terminals.title(id))
    } catch (error) {
      this.deps.log(`Showing the terminal window failed: ${reasonOf(error, 'unknown error')}`)
      throw new Refusal(messages.terminalFailed)
    }
  }

  // --- Terminal connections ---

  private startPty(connection: Connection, role: Extract<DesktopRole, { role: 'pty' }>): void {
    const { terminals, messages } = this.deps
    const conversationId = this.deps.conversationId()
    if (!conversationId) return this.replyError(connection, messages.noConversation)
    const id = role.ptyId
    if (!terminals.belongsTo(conversationId, id) || !terminals.exists(id)) {
      return this.replyError(connection, messages.terminalFailed)
    }

    connection.state = 'pty'
    connection.ptyId = id
    connection.frames = new FrameReader()
    connection.input = new StringDecoder('utf8')

    // Subscribe first, hold what arrives, then send the snapshot and only the chunks after it: nothing is lost, and
    // nothing the snapshot already holds is sent twice.
    let generation = -1
    let sequence = 0
    let live = false
    const held: Array<{ data: string; generation: number; sequence: number }> = []
    const forward = (data: string, meta: { generation: number; sequence: number }): void => {
      if (meta.generation < generation) return
      let text = data
      if (meta.generation > generation) {
        // The shell behind the id was replaced: what the viewer shows belongs to the old one.
        text = TERMINAL_RESET + data
        generation = meta.generation
        sequence = 0
      }
      if (meta.sequence <= sequence) return
      sequence = meta.sequence
      this.sendFrames(connection, FRAME.data, text)
    }
    connection.releases.push(
      terminals.onOutput(id, (data, meta) => {
        if (live) forward(data, meta)
        else held.push({ data, ...meta })
      })
    )
    connection.releases.push(terminals.onExit(id, (code) => this.ptyExited(connection, code)))

    this.write(connection, encodeLine(['ok']))
    const snapshot = terminals.snapshot(id)
    generation = snapshot.generation
    sequence = snapshot.sequence
    this.sendFrames(connection, FRAME.data, snapshot.data)
    live = true
    for (const chunk of held.splice(0)) forward(chunk.data, chunk)
    // The shell redraws for the viewer's size; that output follows the snapshot.
    terminals.resize(id, role.cols, role.rows)

    const rest = connection.lines.takeRest()
    if (rest.length > 0) this.ptyInput(connection, rest)
  }

  private ptyInput(connection: Connection, chunk: Buffer): void {
    const { terminals } = this.deps
    const id = connection.ptyId
    if (!id || !connection.frames || !connection.input) return
    for (const frame of connection.frames.push(chunk)) {
      if (connection.state !== 'pty') return
      if (frame.type === FRAME.data) {
        const text = connection.input.write(frame.payload)
        // A terminal that ended refuses the input; the exit frame tells the viewer.
        if (text !== '') terminals.write(id, text)
      } else if (frame.type === FRAME.size) {
        const { cols, rows } = parseSizePayload(frame.payload)
        terminals.resize(id, cols, rows)
      } else {
        throw new DesktopProtocolError('Unexpected frame')
      }
    }
  }

  private ptyExited(connection: Connection, code: number): void {
    if (connection.state !== 'pty') return
    let last: Buffer
    try {
      last = encodeFrame(FRAME.exit, exitPayload(code, this.deps.messages.exit(code)))
    } catch (error) {
      this.deps.log(`Building the exit frame failed: ${reasonOf(error, 'unknown error')}`)
      this.close(connection)
      return
    }
    this.finish(connection, last)
  }

  /** Writes to the client unless it falls too far behind, which drops it and leaves the terminal alone. */
  private write(connection: Connection, data: Buffer): void {
    if (connection.state === 'closed' || connection.state === 'closing' || connection.socket.destroyed) return
    connection.socket.write(data)
    if (connection.socket.writableLength > this.queuedMax) {
      this.deps.log(`Dropped a desktop connection: its output queue passed ${this.queuedMax} bytes`)
      this.close(connection)
    }
  }

  private sendFrames(connection: Connection, type: number, data: string): void {
    if (data === '') return
    const bytes = Buffer.from(data, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += OUTPUT_FRAME_BYTES) {
      this.write(connection, encodeFrame(type, bytes.subarray(offset, offset + OUTPUT_FRAME_BYTES)))
    }
  }

  // --- Presenter connection ---

  private startPresenter(connection: Connection): void {
    const attach = this.deps.attachPresenter
    if (!attach) return this.replyError(connection, this.deps.messages.presenterUnavailable)

    connection.state = 'presenter'
    this.write(connection, encodeLine(['ok']))
    const link: PresenterLink = {
      send: (fields) => this.write(connection, encodeLine(fields)),
      onLine: (listener) => {
        connection.lineListeners.push(listener)
      },
      onClose: (listener) => {
        connection.closeListeners.push(listener)
      },
      close: () => this.close(connection),
    }
    try {
      attach(link)
    } catch (error) {
      this.deps.log(`Attaching the presenter failed: ${reasonOf(error, 'unknown error')}`)
      this.close(connection)
      return
    }
    // Lines that arrived together with the role line.
    this.presenterInput(connection, Buffer.alloc(0))
  }

  private presenterInput(connection: Connection, chunk: Buffer): void {
    for (const fields of connection.lines.push(chunk)) {
      for (const listener of [...connection.lineListeners]) {
        if (connection.state !== 'presenter') return
        try {
          listener(fields)
        } catch (error) {
          this.deps.log(`A presenter line listener failed: ${reasonOf(error, 'unknown error')}`)
        }
      }
    }
  }
}
