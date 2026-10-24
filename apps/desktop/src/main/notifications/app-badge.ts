import { type BrowserWindow, nativeImage, type NativeImage } from 'electron'

export interface AppBadgeDeps {
  platform: NodeJS.Platform
  /** Electron's app.setBadgeCount: the Dock on macOS, launchers that support it on Linux. */
  setBadgeCount(count: number): void
  mainWindow(): BrowserWindow | null
  /** What a screen reader says of the Windows taskbar mark. */
  description(count: number): string
}

const MAX_COUNT = 9_999
const DOT_SIZE = 16

let dot: NativeImage | null = null

/** A red dot for the Windows taskbar button, which shows no count. */
function redDot(): NativeImage {
  if (dot) return dot
  const pixels = Buffer.alloc(DOT_SIZE * DOT_SIZE * 4)
  const center = (DOT_SIZE - 1) / 2
  for (let y = 0; y < DOT_SIZE; y++)
    for (let x = 0; x < DOT_SIZE; x++) {
      // Coverage of the pixel by a circle of radius 7.5, smoothed over one pixel; BGRA, premultiplied.
      const alpha = Math.max(0, Math.min(1, DOT_SIZE / 2 - Math.hypot(x - center, y - center)))
      const at = (y * DOT_SIZE + x) * 4
      pixels[at] = Math.round(0x44 * alpha)
      pixels[at + 1] = Math.round(0x44 * alpha)
      pixels[at + 2] = Math.round(0xef * alpha)
      pixels[at + 3] = Math.round(0xff * alpha)
    }
  dot = nativeImage.createFromBitmap(pixels, { width: DOT_SIZE, height: DOT_SIZE })
  return dot
}

/**
 * The count on the app's icon of what needs the owner: conversations of every host that wait for them, requests of
 * bots, and bots with something new, as the window counts them.
 */
export class AppBadge {
  private count = 0

  constructor(private readonly deps: AppBadgeDeps) {}

  set(count: unknown): void {
    const next = typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? Math.min(count, MAX_COUNT) : 0
    if (next === this.count) return
    this.count = next
    this.apply()
  }

  /** Shows the count again; the Windows mark belongs to the window, so a new main window needs it again. */
  apply(): void {
    if (this.deps.platform !== 'win32') {
      this.deps.setBadgeCount(this.count)
      return
    }
    const window = this.deps.mainWindow()
    if (!window || window.isDestroyed()) return
    window.setOverlayIcon(this.count ? redDot() : null, this.count ? this.deps.description(this.count) : '')
  }
}
