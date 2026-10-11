import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fleetLoginUrlAllowed, fleetLoginCallbackFromAuthUrl } from '@maestrly/bot-fleet-protocol'

/** Captures Python webbrowser's launch argument without opening a browser on the remote host. */
export async function captureAntigravityBrowser(onUrl: (url: string) => void): Promise<{
  env: NodeJS.ProcessEnv
  close(): Promise<void>
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'maestrly-google-login-'))
  const script = path.join(directory, 'browser')
  const output = path.join(directory, 'url')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  try {
    await writeFile(
      script,
      '#!/bin/sh\numask 077\nprintf "%s" "$1" > ' +
        quote(output + '.tmp') +
        '\n/bin/mv ' +
        quote(output + '.tmp') +
        ' ' +
        quote(output) +
        '\n',
      { mode: 0o700 }
    )
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let closed = false
  let delivered = false
  let reading = Promise.resolve()
  const timer = setInterval(() => {
    reading = reading
      .then(async () => {
        if (closed || delivered) return
        const url = await readFile(output, 'utf8').catch(() => '')
        if (!url || !fleetLoginUrlAllowed('antigravity', url) || !fleetLoginCallbackFromAuthUrl(url)) return
        delivered = true
        onUrl(url)
      })
      .catch(() => undefined)
  }, 100)
  timer.unref()
  return {
    // Python's webbrowser uses shlex.split when BROWSER contains %s.
    env: { BROWSER: '/bin/sh ' + quote(script) + ' %s' },
    async close() {
      closed = true
      clearInterval(timer)
      await reading
      await rm(directory, { recursive: true, force: true })
    },
  }
}
