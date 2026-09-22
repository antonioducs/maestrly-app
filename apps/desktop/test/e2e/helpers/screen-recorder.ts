import { spawn, type ChildProcess } from 'node:child_process'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** Records an X11 region with ffmpeg; used when Playwright Electron recordVideo is unavailable. */
export class ScreenRecorder {
  private proc: ChildProcess | null = null

  start(display: string, bounds: Bounds, outputPath: string): void {
    if (this.proc) throw new Error('Screen recording is already running.')
    this.proc = spawn(
      'ffmpeg',
      [
        '-y',
        '-f',
        'x11grab',
        '-draw_mouse',
        '1',
        '-framerate',
        '30',
        '-video_size',
        `${bounds.width}x${bounds.height}`,
        '-i',
        `${display}+${bounds.x},${bounds.y}`,
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '5',
        outputPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    )
  }

  async stop(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    await new Promise<void>((resolve) => {
      const finish = () => resolve()
      proc.once('close', finish)
      proc.stdin?.write('q')
      setTimeout(() => {
        proc.kill('SIGTERM')
        finish()
      }, 8_000)
    })
  }
}

export function canRecordX11(): boolean {
  return process.platform === 'linux' && Boolean(process.env.DISPLAY)
}
