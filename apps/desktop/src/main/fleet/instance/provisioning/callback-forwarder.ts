import http from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { FLEET_PROVISIONING_LIMITS, type FleetLoginCallbackResponse } from '@maestrly/bot-fleet-protocol'

type Target = { port: number; path: string }
interface HelperReply {
  reply: FleetLoginCallbackResponse
  rawLocation: string | null
}

/**
 * A redirect back to the same local helper (Codex sends `http://localhost:<port>/success?id_token=…` when the account
 * still needs setup, and its login server only finishes once that page loads).
 */
function sameHelperRedirect(location: string | null, target: Target): { path: string; query: string } | null {
  if (!location) return null
  try {
    const url = new URL(location, `http://localhost:${target.port}${target.path}`)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
    if (Number(url.port || 80) !== target.port || url.username || url.password) return null
    return { path: url.pathname, query: url.search.slice(1) }
  } catch {
    return null
  }
}

function requestCallback(hostname: string, target: Target, query: string, timeoutMs: number): Promise<HelperReply> {
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
          const location = response.headers.location ?? null
          resolve({
            reply: {
              status: response.statusCode ?? 502,
              location: location?.startsWith('https://') ? location.slice(0, 4096) : null,
              contentType: response.headers['content-type']?.slice(0, 200) ?? null,
              body: new StringDecoder('utf8').write(
                Buffer.from(new StringDecoder('utf8').write(Buffer.concat(chunks))).subarray(
                  0,
                  FLEET_PROVISIONING_LIMITS.callbackBodyMax
                )
              ),
            },
            rawLocation: location,
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
  target: Target,
  query: string,
  options: { timeoutMs?: number } = {}
): Promise<FleetLoginCallbackResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  const remaining = () => Math.max(1, deadline - Date.now())
  try {
    let hostname = '127.0.0.1'
    let first: HelperReply
    try {
      first = await requestCallback(hostname, target, query, remaining())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ECONNREFUSED' && code !== 'EADDRNOTAVAIL') throw error
      hostname = '::1'
      first = await requestCallback(hostname, target, query, remaining())
    }
    const local =
      first.reply.status >= 300 && first.reply.status < 400 ? sameHelperRedirect(first.rawLocation, target) : null
    if (!local) return first.reply
    // Load it here, so the sign-in completes and the tokens in that URL never leave the bot.
    const followed = await requestCallback(hostname, { port: target.port, path: local.path }, local.query, remaining())
    return { status: followed.reply.status, location: null, contentType: null, body: '' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error('The sign-in helper on the bot did not answer: ' + (code ?? 'connection failed'))
  }
}
