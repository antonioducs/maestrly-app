import { execFile } from 'node:child_process'

/** Runs a program and resolves with its output; rejects when it fails or takes longer than `timeoutMs`. */
export type RunText = (command: string, args: string[], timeoutMs: number) => Promise<string>

const XPROP_TIMEOUT_MS = 2_000

export const execFileText: RunText = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })

/**
 * The windows the window manager of an X display manages, with the process id each reports (`_NET_WM_PID`), or null
 * for one that reports none. A display whose window manager lists no windows has none. When the list cannot be read,
 * the answer is one window of unknown origin, so a computer whose windows nobody could check is kept.
 */
export async function listDisplayWindows(
  display: string,
  run: RunText = execFileText
): Promise<{ pid: number | null }[]> {
  try {
    const list = await run('xprop', ['-display', display, '-root', '_NET_CLIENT_LIST'], XPROP_TIMEOUT_MS)
    if (/not found/.test(list)) return []
    const ids = list.slice(list.indexOf('#') + 1).match(/0x[0-9a-f]+/gi) ?? []
    const windows: { pid: number | null }[] = []
    for (const id of ids) {
      const reply = await run('xprop', ['-display', display, '-id', id, '_NET_WM_PID'], XPROP_TIMEOUT_MS)
      const pid = /=\s*(\d+)/.exec(reply)?.[1]
      windows.push({ pid: pid === undefined ? null : Number(pid) })
    }
    return windows
  } catch {
    return [{ pid: null }]
  }
}
