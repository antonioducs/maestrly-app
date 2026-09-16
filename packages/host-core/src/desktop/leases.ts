import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { DESKTOP_LIMITS } from '@maestrly/host-protocol'

export type Controller = { capabilityHash: Buffer; epoch: number; deadline: number; sequence: number; applied: number }
export type Viewer = {
  viewId: string
  botId: string
  sessionId: string
  sessionGeneration: number
  connectionId: string
  clientInstanceId: string
  grantId: string
  deadline: number
  stream?: Duplex
  controller?: Controller
}
const digest = (value: string) => createHash('sha256').update(value).digest()
/**
 * Ephemeral viewers and controllers. Viewer leases and control leases are separate from
 * turn leases: a task ending never closes a screen a person is watching or controlling.
 */
export class DesktopViewers {
  private viewers = new Map<string, Viewer>()
  constructor(private readonly clock: () => number = () => performance.now()) {}
  now() {
    return this.clock()
  }
  add(viewer: Omit<Viewer, 'deadline'>) {
    const value: Viewer = { ...viewer, deadline: this.clock() + DESKTOP_LIMITS.viewerLeaseMs }
    this.viewers.set(viewer.viewId, value)
    return value
  }
  get(viewId: string) {
    return this.viewers.get(viewId)
  }
  forBot(botId: string) {
    return [...this.viewers.values()].filter((viewer) => viewer.botId === botId)
  }
  forConnection(connectionId: string) {
    return [...this.viewers.values()].filter((viewer) => viewer.connectionId === connectionId)
  }
  all() {
    return [...this.viewers.values()]
  }
  controllerOf(botId: string) {
    return this.forBot(botId).find((viewer) => viewer.controller)
  }
  renewViewer(viewer: Viewer) {
    viewer.deadline = this.clock() + DESKTOP_LIMITS.viewerLeaseMs
  }
  /** Mints a control capability; only its hash is retained. */
  grantControl(viewer: Viewer, epoch: number) {
    const capability = randomBytes(32).toString('hex')
    viewer.controller = { capabilityHash: digest(capability), epoch, deadline: this.clock() + DESKTOP_LIMITS.controlLeaseMs, sequence: -1, applied: 0 }
    return capability
  }
  verify(viewer: Viewer, capability: string | undefined, epoch?: number) {
    const controller = viewer.controller
    if (!controller || !capability || !/^[a-f0-9]{64}$/.test(capability)) return undefined
    if (!timingSafeEqual(controller.capabilityHash, digest(capability))) return undefined
    if (epoch !== undefined && controller.epoch !== epoch) return undefined
    if (controller.deadline <= this.clock()) return undefined
    return controller
  }
  renewControl(controller: Controller) {
    controller.deadline = this.clock() + DESKTOP_LIMITS.controlLeaseMs
  }
  revokeControl(viewer: Viewer) {
    const had = !!viewer.controller
    viewer.controller = undefined
    return had
  }
  remove(viewId: string) {
    const viewer = this.viewers.get(viewId)
    this.viewers.delete(viewId)
    return viewer
  }
  expiredViewers() {
    const now = this.clock()
    return this.all().filter((viewer) => viewer.deadline <= now)
  }
  expiredControllers() {
    const now = this.clock()
    return this.all().filter((viewer) => viewer.controller && viewer.controller.deadline <= now)
  }
}
