import { fork } from 'node:child_process'
import { VOICE_LIMITS } from '@maestrly/host-protocol'
import type { AsrBundle } from './assets.js'
import type { AsrWorkerFactory, AsrWorkerHandle } from './worker-client.js'

/**
 * Production factory: one Node process per worker, started from the entry point of a bundle
 * whose every file was verified against its manifest digest before this is ever called.
 *
 * The child gets a deliberately small environment. It is told where its own verified bundle
 * is and nothing else — no Host state directory, no credentials, no inherited PATH surprises —
 * because a speech model has no business being able to reach any of that.
 *
 * Audio crosses as a real Float32Array thanks to advanced (structured-clone) serialisation;
 * JSON would turn a few seconds of speech into megabytes of decimal text.
 */
export function forkAsrWorker(options: { execPath?: string } = {}): AsrWorkerFactory {
  return (bundle: AsrBundle): AsrWorkerHandle => {
    const child = fork(bundle.entry, [], {
      serialization: 'advanced',
      // stderr is piped and dropped: a transcript must never reach a log file.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execPath: options.execPath ?? process.execPath,
      // Nothing of the parent's command line reaches the worker: an inherited `--input-type`,
      // an inspector port or a module loader would either break it or widen what it can do.
      execArgv: [],
      env: {
        MAESTRLY_ASR_ROOT: bundle.root,
        MAESTRLY_ASR_MODEL: bundle.modelId,
        MAESTRLY_ASR_THREADS: String(VOICE_LIMITS.maxInferenceThreads),
        NODE_ENV: 'production',
        PATH: '/usr/bin:/bin',
      },
    })
    child.stderr?.resume()
    let alive = true
    const exits: ((reason: string) => void)[] = []
    child.once('exit', (code, signal) => {
      alive = false
      for (const listener of exits) listener(signal ? `signal ${signal}` : `exit ${code ?? 0}`)
    })
    child.once('error', (error) => {
      alive = false
      for (const listener of exits) listener(error.message.slice(0, 200))
    })
    return {
      send(request) {
        if (!alive) throw new Error('Transcription worker is not running')
        child.send(request)
      },
      onMessage(listener) {
        child.on('message', (message) => listener(message))
      },
      onExit(listener) {
        exits.push(listener)
      },
      kill() {
        if (!alive) return
        alive = false
        // A stuck inference does not answer SIGTERM; the follow-up is not optional.
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
        timer.unref?.()
      },
    }
  }
}
