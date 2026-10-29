import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FLEET_RUNNER_LIMITS } from '@maestrly/bot-fleet-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunnerApiError } from '../../src/main/runner/api'
import { RunnerLogPump, redactEnvValues } from '../../src/main/runner/log-pump'
import { cleanTempDirs, FakeRunnerApi, JOB_ID, tempDir, transient } from '../helpers/runner-core'

afterEach(cleanTempDirs)

function setup(extra: Partial<ConstructorParameters<typeof RunnerLogPump>[0]> = {}) {
  const api = new FakeRunnerApi()
  const file = path.join(tempDir(), 'job.log')
  const pump = new RunnerLogPump({ api, jobId: JOB_ID, file, env: {}, intervalMs: 10, backoff: () => 1, ...extra })
  return { api, file, pump }
}
const local = (file: string) => readFileSync(file, 'utf8')

describe('runner log pump', () => {
  it('keeps the output in a local file and sends it at explicit offsets', async () => {
    const { api, file, pump } = setup()
    pump.write(Buffer.from('first line\n'))
    await vi.waitFor(() => expect(api.logBytes.toString()).toBe('first line\n'))
    pump.write(Buffer.from('second line\n'))
    expect(await pump.flush()).toBe(true)
    expect(api.logBatches).toEqual([
      { offset: 0, length: 11 },
      { offset: 11, length: 12 },
    ])
    expect(local(file)).toBe('first line\nsecond line\n')
    await pump.close()
  })

  it('sends at once when 64 KiB are pending, in batches no larger than the gateway takes', async () => {
    const { api, pump } = setup({ intervalMs: 60_000, sendBytes: 64 * 1024 })
    const total = FLEET_RUNNER_LIMITS.logBatchBytesMax * 2 + 1000
    pump.write(Buffer.alloc(total, 'x'))
    await vi.waitFor(() => expect(api.logBytes.length).toBe(total))
    expect(api.logBatches.map((batch) => batch.offset)).toEqual([
      0,
      FLEET_RUNNER_LIMITS.logBatchBytesMax,
      FLEET_RUNNER_LIMITS.logBatchBytesMax * 2,
    ])
    expect(api.logBatches.every((batch) => batch.length <= FLEET_RUNNER_LIMITS.logBatchBytesMax)).toBe(true)
    await pump.close()
  })

  it('waits for its interval when little is pending', async () => {
    const { api, pump } = setup({ intervalMs: 80 })
    pump.write(Buffer.from('small'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.logBytes.length).toBe(0)
    await vi.waitFor(() => expect(api.logBytes.toString()).toBe('small'))
    await pump.close()
  })

  it('tries a batch again when the gateway does not answer, without holding up the output', async () => {
    const { api, file, pump } = setup()
    let failures = 3
    api.fault = ({ method }) => (method === 'log' && failures-- > 0 ? transient() : undefined)
    pump.write(Buffer.from('survives\n'))
    // The job goes on writing while the gateway is out of reach.
    pump.write(Buffer.from('more\n'))
    expect(await pump.flush()).toBe(true)
    expect(api.logBytes.toString()).toBe('survives\nmore\n')
    expect(local(file)).toBe('survives\nmore\n')
    await pump.close()
  })

  it('flush gives up after its wait and says the gateway does not hold the log', async () => {
    const { api, file, pump } = setup()
    api.fault = ({ method }) => (method === 'log' ? transient() : undefined)
    pump.write(Buffer.from('never delivered\n'))
    expect(await pump.flush(60)).toBe(false)
    expect(local(file)).toBe('never delivered\n')
    await pump.close()
  })

  it('sends the log again from the start when the environment holds less than expected', async () => {
    const { api, pump } = setup()
    pump.write(Buffer.from('aaaa'))
    await vi.waitFor(() => expect(api.logBytes.length).toBe(4))
    api.logBytes = Buffer.alloc(0) // the environment lost its copy
    pump.write(Buffer.from('bbbb'))
    expect(await pump.flush()).toBe(true)
    expect(api.logBytes.toString()).toBe('aaaabbbb')
    await pump.close()
  })

  it('stops sending, and keeps the file, when the gateway refuses the log', async () => {
    const { api, file, pump } = setup()
    api.fault = ({ method }) =>
      method === 'log' ? new RunnerApiError(409, 'CONFLICT', 'The job is not running', false) : undefined
    pump.write(Buffer.from('kept locally\n'))
    expect(await pump.flush()).toBe(false)
    expect(api.logBatches).toEqual([])
    expect(local(file)).toBe('kept locally\n')
    await pump.close()
  })

  describe('redaction', () => {
    const env = { TOKEN: 'sup3r-secret', SHORT: 'abc', PASSWORD: 'hunter2hunter2' }

    it('replaces the values of the job environment in the file and in what is sent', async () => {
      const { api, file, pump } = setup({ env })
      pump.write(Buffer.from('token is sup3r-secret and again sup3r-secret\n'))
      pump.write(Buffer.from('short abc stays; hunter2hunter2 goes\n'))
      expect(await pump.flush()).toBe(true)
      const expected = 'token is *** and again ***\nshort abc stays; *** goes\n'
      expect(local(file)).toBe(expected)
      expect(api.logBytes.toString()).toBe(expected)
      await pump.close()
    })

    it('finds a value split across two writes, and holds back only what may start one', async () => {
      const { api, file, pump } = setup({ env })
      pump.write(Buffer.from('value: sup3r-'))
      pump.write(Buffer.from('secret done\nand sup3'))
      pump.write(Buffer.from('r-nothing\n'))
      expect(await pump.flush()).toBe(true)
      expect(local(file)).toBe('value: *** done\nand sup3r-nothing\n')
      expect(api.logBytes.toString()).toBe('value: *** done\nand sup3r-nothing\n')
      await pump.close()
    })

    it('releases held-back bytes on flush: an unfinished value is plain text by then', async () => {
      const { api, pump } = setup({ env })
      pump.write(Buffer.from('ends with sup3r-'))
      expect(await pump.flush()).toBe(true)
      expect(api.logBytes.toString()).toBe('ends with sup3r-')
      await pump.close()
    })

    it('hides the longer value first when one contains another', () => {
      expect(redactEnvValues('x=abcdefgh y=abcd', { A: 'abcd', B: 'abcdefgh' })).toBe('x=*** y=***')
      expect(redactEnvValues('nothing here', env)).toBe('nothing here')
    })
  })

  describe('tail', () => {
    it('reads the last lines, within the last bytes', async () => {
      const { pump } = setup()
      pump.write(Buffer.from(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'))
      expect(await pump.tail(3, 4096)).toBe('line 8\nline 9\nline 10')
      expect(await pump.tail(100, 4096)).toContain('line 1\nline 2')
      // 22 bytes are exactly the last three lines; 20 cut the third from last, which is left out.
      expect(await pump.tail(100, 22)).toBe('line 8\nline 9\nline 10')
      expect(await pump.tail(100, 20)).toBe('line 9\nline 10')
      await pump.close()
    })
    it('is empty for a job that printed nothing', async () => {
      const { pump } = setup()
      expect(await pump.tail(10, 100)).toBe('')
      await pump.close()
    })
  })
})
