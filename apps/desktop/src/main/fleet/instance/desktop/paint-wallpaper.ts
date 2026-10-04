import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FLEET_SCREEN } from '@maestrly/bot-fleet-protocol'
import { wallpaperSvg } from './wallpaper'

const RENDER_TIMEOUT_MS = 15_000
const ROOT_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 1024 * 1024

export interface WallpaperTarget {
  /** The bot's own folder under `~/.cache/maestrly-bots`, where the wallpaper files are kept. */
  folder: string
  /** The bot's apps display, such as `:2`. */
  display: string
  name: string
  /** `#rrggbb`; anything else, or none, gives the neutral color. */
  tint?: string | null
}

/** Runs a program found on `PATH` and rejects with a one-line reason when it cannot run, fails or takes too long. */
function run(command: string, args: string[], env: Record<string, string>, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout, maxBuffer: OUTPUT_LIMIT, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) return resolve()
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        const detail = stderr.trim().split('\n')[0]
        const reason = failure.killed
          ? `did not finish within ${timeout / 1_000} s`
          : failure.code === 'ENOENT'
            ? 'is not installed'
            : `failed (${failure.code ?? failure.signal})${detail ? `: ${detail}` : ''}`
        reject(new Error(`${command} ${reason}`))
      }
    )
  })
}

/**
 * Paints a bot's wallpaper on its apps display: writes `wallpaper.svg` in the bot's folder, renders it at the size of
 * the screen with `rsvg-convert` and sets it as the root image with `hsetroot`, which also publishes the root pixmap
 * the taskbar looks through. It rejects when a step fails, and then leaves the screen as it was.
 */
export async function paintWallpaper(target: WallpaperTarget, options: { timeoutMs?: number } = {}): Promise<void> {
  const svg = path.join(target.folder, 'wallpaper.svg')
  const png = path.join(target.folder, 'wallpaper.png')
  await fs.mkdir(target.folder, { recursive: true, mode: 0o700 })
  await fs.writeFile(svg, wallpaperSvg(target), { mode: 0o600 })
  await run(
    'rsvg-convert',
    ['-w', String(FLEET_SCREEN.width), '-h', String(FLEET_SCREEN.height), '-o', png, svg],
    {},
    options.timeoutMs ?? RENDER_TIMEOUT_MS
  )
  await run('hsetroot', ['-cover', png], { DISPLAY: target.display }, options.timeoutMs ?? ROOT_TIMEOUT_MS)
}
