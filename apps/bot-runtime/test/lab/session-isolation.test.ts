import { readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'

// A report is accepted only with its exact installed bundle. CI has neither opt-in.
test.skipIf(!process.env.MAESTRLY_BOT_SESSION_REPORT || !process.env.MAESTRLY_BOT_SESSION_BUNDLE)(
  'verified Linux bundle: independent desktops, UID boundaries, egress, leases and recovery', async () => {
    const report = JSON.parse(await readFile(process.env.MAESTRLY_BOT_SESSION_REPORT!, 'utf8'))
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(process.env.MAESTRLY_BOT_SESSION_BUNDLE!)) hash.update(bytes)
    expect(report.bundleSha256).toBe(hash.digest('hex'))
    expect(report).toMatchObject({ installedBundleVerified: true, verified: true, sessions: 2, network: 'none', isolation: true, perSessionNetwork: true, streamRevocation: true, sessionLeaseExpiry: true, reconnect: true, guestReboot: true, browserProfilesPreserved: true })
    expect(report.captures[0]).not.toBe(report.captures[1])
    expect(report.input.map((value: { input: string }) => value.input)).toEqual(['input-a', 'input-b'])
    for (const usage of report.usage) expect(usage.counters).toContain('oom_kill 0')
  }, 20000)
