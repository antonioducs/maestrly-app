import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerApiError } from '../../src/main/runner/api'
import { RunnerJobError } from '../../src/main/runner/errors'
import { uploadRunnerOutputs } from '../../src/main/runner/upload'
import { cleanTempDirs, FakeRunnerApi, JOB_ID, sha256Hex, tempDir, transient } from '../helpers/runner-core'

afterEach(cleanTempDirs)

const content = Buffer.from('0123456789abcdefghij') // 20 bytes
function archiveFile(): { file: string; archive: { bytes: number; sha256: string } } {
  const file = path.join(tempDir(), 'outputs.tar.zst')
  writeFileSync(file, content)
  return { file, archive: { bytes: content.length, sha256: sha256Hex(content) } }
}
const options = (extra: Partial<Parameters<typeof uploadRunnerOutputs>[4]> = {}) => ({
  signal: new AbortController().signal,
  chunkBytes: 8,
  backoff: () => 1_000,
  sleep: async () => undefined,
  ...extra,
})

describe('uploading the outputs of a job', () => {
  it('sends chunks with their digests at explicit offsets and commits the whole', async () => {
    const api = new FakeRunnerApi()
    const sent: Array<{ offset: number; sha: string; length: number }> = []
    api.fault = ({ method, args }) => {
      if (method === 'outputChunk')
        sent.push({ offset: args[0] as number, sha: args[2] as string, length: (args[1] as Buffer).length })
      return undefined
    }
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(api, JOB_ID, file, archive, options())
    expect(sent.map((chunk) => [chunk.offset, chunk.length])).toEqual([
      [0, 8],
      [8, 8],
      [16, 4],
    ])
    expect(sent[0]?.sha).toBe(sha256Hex(content.subarray(0, 8)))
    expect(api.outputBytes.equals(content)).toBe(true)
    expect(api.commit).toEqual(archive)
  })

  it('resumes from the offset the environment reports', async () => {
    const api = new FakeRunnerApi()
    api.outputBytes = Buffer.from(content.subarray(0, 12))
    const offsets: number[] = []
    api.fault = ({ method, args }) => {
      if (method === 'outputChunk') offsets.push(args[0] as number)
      return undefined
    }
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(api, JOB_ID, file, archive, options())
    expect(offsets).toEqual([12])
    expect(api.commit).toEqual(archive)
  })

  it('commits at once when the environment already holds everything', async () => {
    const api = new FakeRunnerApi()
    api.outputBytes = Buffer.from(content)
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(api, JOB_ID, file, archive, options())
    expect(api.calls.filter((call) => call.method === 'outputChunk')).toEqual([])
    expect(api.commit).toEqual(archive)
  })

  it('starts over when the environment reports more than there is to send', async () => {
    const api = new FakeRunnerApi()
    api.outputBytes = Buffer.alloc(50, 1)
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(api, JOB_ID, file, archive, options())
    expect(api.outputBytes.equals(content)).toBe(true)
  })

  it('reads the status again after a 409 and goes on from there', async () => {
    const api = new FakeRunnerApi()
    let refused = false
    api.fault = ({ method, args }) => {
      if (method === 'outputChunk' && args[0] === 8 && !refused) {
        refused = true
        // Another attempt got a chunk in meanwhile: the environment now holds 16 bytes.
        api.outputBytes = Buffer.from(content.subarray(0, 16))
        return new RunnerApiError(409, 'CONFLICT', 'Offset does not match', false)
      }
      return undefined
    }
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(api, JOB_ID, file, archive, options())
    const statuses = api.calls.filter((call) => call.method === 'outputsStatus')
    expect(statuses).toHaveLength(2)
    expect(api.outputBytes.equals(content)).toBe(true)
    expect(api.commit).toEqual(archive)
  })

  it('gives up when the environment keeps refusing with conflicts', async () => {
    const api = new FakeRunnerApi()
    api.fault = ({ method }) =>
      method === 'outputChunk' ? new RunnerApiError(409, 'CONFLICT', 'Offset does not match', false) : undefined
    const { file, archive } = archiveFile()
    const error = await uploadRunnerOutputs(api, JOB_ID, file, archive, options()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RunnerJobError)
    expect((error as RunnerJobError).code).toBe('transfer_failed')
  })

  it('waits with growing pauses while the environment does not answer, then goes on', async () => {
    const api = new FakeRunnerApi()
    let failures = 3
    api.fault = ({ method }) => {
      if (method === 'outputChunk' && failures > 0) {
        failures--
        return transient()
      }
      return undefined
    }
    const pauses: number[] = []
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(
      api,
      JOB_ID,
      file,
      archive,
      options({
        backoff: (attempt) => 100 * 2 ** attempt,
        sleep: async (ms) => {
          pauses.push(ms)
        },
      })
    )
    expect(pauses).toEqual([100, 200, 400])
    expect(api.outputBytes.equals(content)).toBe(true)
    expect(api.commit).toEqual(archive)
  })

  it('retries a status or commit the environment did not answer', async () => {
    const api = new FakeRunnerApi()
    let statusFailed = false
    let commitFailed = false
    api.fault = ({ method }) => {
      if (method === 'outputsStatus' && !statusFailed) {
        statusFailed = true
        return transient()
      }
      if (method === 'outputCommit' && !commitFailed) {
        commitFailed = true
        return transient()
      }
      return undefined
    }
    const { file, archive } = archiveFile()
    await uploadRunnerOutputs(api, JOB_ID, file, archive, options())
    expect(api.commit).toEqual(archive)
  })

  it('fails with outputs_undelivered once the deadline has passed', async () => {
    const api = new FakeRunnerApi()
    api.fault = () => transient('the environment is down')
    let clock = 0
    const pauses: number[] = []
    const { file, archive } = archiveFile()
    const error = await uploadRunnerOutputs(
      api,
      JOB_ID,
      file,
      archive,
      options({
        deadlineMs: 10_000,
        backoff: () => 4_000,
        now: () => clock,
        sleep: async (ms) => {
          pauses.push(ms)
          clock += ms
        },
      })
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RunnerJobError)
    expect((error as RunnerJobError).code).toBe('outputs_undelivered')
    expect((error as RunnerJobError).message).toContain('the environment is down')
    // Two pauses of 4 s fit; a third would end at 12 s, past the 10 s deadline.
    expect(pauses).toEqual([4_000, 4_000])
  })

  it('does not retry a refusal that is not transient', async () => {
    const api = new FakeRunnerApi()
    api.fault = ({ method }) =>
      method === 'outputChunk' ? new RunnerApiError(403, 'FORBIDDEN', 'Not your job', false) : undefined
    const { file, archive } = archiveFile()
    await expect(uploadRunnerOutputs(api, JOB_ID, file, archive, options())).rejects.toThrow('Not your job')
    expect(api.calls.filter((call) => call.method === 'outputChunk')).toHaveLength(1)
  })

  it('stops when the job is cancelled, also while it waits', async () => {
    const api = new FakeRunnerApi()
    api.fault = () => transient()
    const controller = new AbortController()
    const { file, archive } = archiveFile()
    const upload = uploadRunnerOutputs(
      api,
      JOB_ID,
      file,
      archive,
      options({
        signal: controller.signal,
        sleep: (_ms, signal) =>
          new Promise((_resolve, reject) => {
            controller.abort(new Error('cancelled'))
            reject(signal.reason)
          }),
      })
    )
    await expect(upload).rejects.toThrow('cancelled')
  })
})
