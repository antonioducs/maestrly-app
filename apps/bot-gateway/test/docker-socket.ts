import path from 'node:path'

/**
 * Where a test's fake Docker Engine listens: a socket file in `dir`, or on Windows, which cannot listen on a file
 * path, a named pipe as Docker Desktop uses there. The gateway reaches both the same way.
 */
export function dockerSocketPath(dir: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}-docker` : path.join(dir, 'docker.sock')
}
