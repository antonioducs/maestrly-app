import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/** The POSIX child must be spawned detached so its PID owns a private process group. */
export class CodexProcessTree {
  private shutdown: Promise<void> | undefined
  private rootExited = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.once('exit', () => {
      this.rootExited = true
      // Descendants can keep stdout/stderr open, so do not wait for `close`.
      void this.stop(100).catch(() => {})
    })
  }

  stop(gracePeriodMs: number): Promise<void> {
    this.shutdown ??= this.stopTree(gracePeriodMs)
    return this.shutdown
  }

  private async stopTree(gracePeriodMs: number): Promise<void> {
    const pid = this.child.pid
    if (!pid) return
    if (process.platform === 'win32') {
      // taskkill needs the live root to discover its descendants. Do this before
      // sending EOF; never target a stale PID after the root has exited.
      if (this.rootExited) return
      await new Promise<void>((resolve, reject) => {
        execFile(
          'taskkill.exe',
          ['/PID', String(pid), '/T', '/F'],
          {
            windowsHide: true,
            timeout: 5_000,
          },
          async (error, _stdout, stderr) => {
            if (!error) return resolve()
            // taskkill can report a child that exited while its parent tree was being killed.
            // Accept only confirmed root exit and exclusively already-exited diagnostics.
            const reasons = String(stderr)
              .split(/\r?\n/)
              .filter((line) => /^Reason:/i.test(line.trim()))
            if (reasons.length > 0 && reasons.every((line) => /There is no running instance of the task/i.test(line))) {
              // The taskkill callback may run before Node delivers the root's exit event.
              // Wait on our ChildProcess, never probe or kill a potentially reused PID.
              if (!this.rootExited) {
                await new Promise<void>((done) => {
                  const finish = (): void => {
                    clearTimeout(timer)
                    this.child.removeListener('exit', finish)
                    done()
                  }
                  const timer = setTimeout(finish, 1_000)
                  this.child.once('exit', finish)
                })
              }
              if (this.rootExited) resolve()
              else reject(error)
            } else reject(error)
          }
        )
      })
      return
    }

    const hasLiveMembers = (): Promise<boolean> =>
      new Promise((resolve, reject) => {
        execFile('ps', ['-axo', 'pgid=,stat='], { timeout: 1000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
          if (error) return reject(error)
          resolve(
            String(stdout)
              .split('\n')
              .some((line) => {
                const match = /^\s*(\d+)\s+(\S+)/.exec(line)
                return match?.[1] === String(pid) && !match[2].startsWith('Z')
              })
          )
        })
      })
    const signalGroup = async (signal: NodeJS.Signals | 0): Promise<boolean> => {
      try {
        process.kill(-pid, signal)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          // A terminated group may remain as zombies during OS reaping. Confirm
          // that no live member remains; never hide a real permission failure.
          try {
            if (!(await hasLiveMembers())) return false
          } catch {
            /* Keep the original signal error when inspection fails. */
          }
        }
        throw error
      }
    }
    const waitForGroup = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout
      while (await signalGroup(0)) {
        if (Date.now() >= deadline) return false
        await delay(Math.min(20, Math.max(1, deadline - Date.now())))
      }
      return true
    }
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    if (await waitForGroup(gracePeriodMs)) return
    if (!(await signalGroup('SIGTERM'))) return
    if (await waitForGroup(gracePeriodMs)) return
    if (!(await signalGroup('SIGKILL'))) return
    // Allow the OS to finish termination before callers remove writable profiles.
    if (!(await waitForGroup(Math.max(1_000, gracePeriodMs))) && (await hasLiveMembers())) {
      throw new Error('Codex process group did not exit after SIGKILL')
    }
  }
}
