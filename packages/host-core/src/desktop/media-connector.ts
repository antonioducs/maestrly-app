import { lstat } from 'node:fs/promises'
import { connect } from 'node:net'
import { DESKTOP_MEDIA_PROTOCOL, mediaHelloSchema, MEDIA_STREAMS_PER_HOST } from '@maestrly/host-protocol'
import { MediaMux, type MediaStream } from '@maestrly/guest-transport'
import { HostError } from '../errors.js'

/**
 * Host side of the private desktop media lane: one MediaMux per VM over its QEMU
 * virtio-serial socket. It never carries chat, files, egress or control requests, so a
 * congested framebuffer cannot delay a lease renewal or a stop.
 */
export class DesktopMediaConnector {
  private lanes = new Map<string, Promise<MediaMux>>()
  constructor(
    private readonly hostId: string,
    private readonly hostGeneration: number,
    private readonly path: (vmId: string) => string | undefined,
    private readonly helloTimeoutMs = 20_000
  ) {}
  private lane(vmId: string): Promise<MediaMux> {
    const existing = this.lanes.get(vmId)
    if (existing) return existing
    const pending = this.connect(vmId).catch((error) => {
      this.lanes.delete(vmId)
      throw error
    })
    this.lanes.set(vmId, pending)
    return pending
  }
  private async connect(vmId: string) {
    const path = this.path(vmId)
    if (!path) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Reinicie o computador do bot em uma janela autorizada para habilitar a tela')
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isSocket() || info.uid !== process.getuid?.())
      throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Este computador ainda não tem o canal da tela; reinicie-o em uma janela autorizada')
    const socket = connect({ path })
    const mux = new MediaMux(socket, 'host', { maxStreams: MEDIA_STREAMS_PER_HOST })
    try {
      const hello = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new HostError('DESKTOP_UNAVAILABLE', 'O computador do bot não abriu o canal da tela')), this.helloTimeoutMs)
        mux.once('close', () => {
          clearTimeout(timer)
          reject(new HostError('DESKTOP_UNAVAILABLE', 'O canal da tela foi encerrado'))
        })
        mux.once('hello', (value) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
      const parsed = mediaHelloSchema.safeParse(hello)
      if (!parsed.success) throw new HostError('DESKTOP_UPDATE_REQUIRED', 'Canal da tela incompatível')
      mux.welcome({ protocol: DESKTOP_MEDIA_PROTOCOL, nonce: parsed.data.nonce, hostId: this.hostId, hostGeneration: this.hostGeneration })
      // A second hello means the supervisor restarted on the same socket: start over.
      mux.on('hello', () => mux.destroy())
      mux.once('close', () => {
        void this.lanes.get(vmId)?.then((current) => {
          if (current === mux) this.lanes.delete(vmId)
        })
      })
      return mux
    } catch (error) {
      mux.destroy()
      throw error
    }
  }
  async open(vmId: string, payload: { sessionId: string; generation: number; grantId: string }): Promise<MediaStream> {
    const mux = await this.lane(vmId)
    try {
      return await mux.open(payload)
    } catch (error) {
      const code = (error as { code?: string }).code
      throw new HostError(code === 'VIEWER_LIMIT' ? 'VIEWER_LIMIT' : 'DESKTOP_UNAVAILABLE', 'Não foi possível abrir a tela deste bot')
    }
  }
  dropVm(vmId: string) {
    const pending = this.lanes.get(vmId)
    this.lanes.delete(vmId)
    void pending?.then((mux) => mux.destroy()).catch(() => {})
  }
  close() {
    for (const vmId of [...this.lanes.keys()]) this.dropVm(vmId)
  }
}
