import http from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { FLEET_PROVISIONING_LIMITS, type FleetLoginCallbackResponse } from '@maestrly/bot-fleet-protocol'

function requestCallback(
  hostname: string,
  target: { port: number; path: string },
  query: string,
  timeoutMs: number
): Promise<FleetLoginCallbackResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname,
        port: target.port,
        path: target.path + (query ? '?' + query : ''),
        headers: { Host: 'localhost:' + target.port },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          const location = response.headers.location
          resolve({
            status: response.statusCode ?? 502,
            location: location?.startsWith('https://') ? location.slice(0, 4096) : null,
            contentType: response.headers['content-type']?.slice(0, 200) ?? null,
            body: new StringDecoder('utf8').write(
              Buffer.from(new StringDecoder('utf8').write(Buffer.concat(chunks))).subarray(
                0,
                FLEET_PROVISIONING_LIMITS.callbackBodyMax
              )
            ),
          })
        }
        response.on('data', (chunk: Buffer) => {
          const remaining = FLEET_PROVISIONING_LIMITS.callbackBodyMax - bytes
          const kept = chunk.subarray(0, remaining)
          chunks.push(kept)
          bytes += kept.length
          if (bytes >= FLEET_PROVISIONING_LIMITS.callbackBodyMax) {
            finish()
            response.destroy()
          }
        })
        response.once('end', finish)
        response.once('error', reject)
      }
    )
    const timer = setTimeout(
      () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
      timeoutMs
    )
    timer.unref()
    request.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.once('close', () => clearTimeout(timer))
  })
}
export async function forwardLoginCallback(
  target: { port: number; path: string },
  query: string,
  options: { timeoutMs?: number } = {}
): Promise<FleetLoginCallbackResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  try {
    try {
      return await requestCallback('127.0.0.1', target, query, Math.max(1, deadline - Date.now()))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ECONNREFUSED' && code !== 'EADDRNOTAVAIL') throw error
      return await requestCallback('::1', target, query, Math.max(1, deadline - Date.now()))
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error('The sign-in helper on the bot did not answer: ' + (code ?? 'connection failed'))
  }
}
