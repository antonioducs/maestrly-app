import { spawn, type ChildProcess } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { constants } from 'node:fs'
import { runtimeError } from '../turns/service.js'
const xvfb = () => process.env.MAESTRLY_XVFB_BINARY ?? '/usr/bin/Xvfb'
export class DesktopSession {
  private children: ChildProcess[] = []
  private starting?: Promise<void>
  readonly display = process.env.DISPLAY ?? ':10'
  readonly width = Number(process.env.MAESTRLY_DESKTOP_WIDTH ?? 1280)
  readonly height = Number(process.env.MAESTRLY_DESKTOP_HEIGHT ?? 800)
  environment(): NodeJS.ProcessEnv {
    if (!/^:[0-9]{1,4}$/.test(this.display) || !Number.isSafeInteger(this.width) || !Number.isSafeInteger(this.height) || this.width < 320 || this.height < 240 || this.width > 4096 || this.height > 4096)
      throw runtimeError('DESKTOP_CONFIGURATION', 'Invalid managed desktop configuration')
    return { ...process.env, DISPLAY: this.display }
  }
  async generation() {
    if (!process.env.MAESTRLY_BOT_SESSION_ID) return this.display
    return (await readFile(join(process.env.MAESTRLY_BOT_STATE!, 'desktop-generation'), 'utf8')).trim()
  }
  static async available() {
    return access(xvfb(), constants.X_OK).then(
      () => true,
      () => false
    )
  }
  async ensure() {
    if (this.starting) return this.starting
    this.starting = this.start().catch((error) => {
      this.starting = undefined
      throw error
    })
    return this.starting
  }
  private async start() {
    if (!(await DesktopSession.available())) throw runtimeError('BROWSER_UNAVAILABLE', 'Xvfb is not installed')
    // Packaged service owns display :10. Development and tests supervise it here.
    if (process.env.MAESTRLY_BOT_DESKTOP_MANAGED === '1') return
    await this.launch(xvfb(), [this.display, '-screen', '0', `${this.width}x${this.height}x24`, '-nolisten', 'tcp'])
    if (
      await access('/usr/bin/openbox', constants.X_OK).then(
        () => true,
        () => false
      )
    )
      await this.launch('/usr/bin/openbox', [])
  }
  private async launch(command: string, args: string[]) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: this.environment() })
    this.children.push(child)
    child.once('exit', () => {
      this.starting = undefined
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 250)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(runtimeError('BROWSER_UNAVAILABLE', error.message))
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(runtimeError('BROWSER_UNAVAILABLE', 'Desktop process exited'))
      })
    })
  }
  async close() {
    for (const child of this.children.splice(0)) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {}
      }
    }
    this.starting = undefined
  }
}
