import {
  FLEET_GATEWAY_ROUTES,
  FLEET_FILE_LIMITS,
  fleetFileIdSchema,
  type FleetFileRef,
  FLEET_PROTOCOL_VERSION,
  FLEET_IMAGE_LIMITS,
  buildPath,
  fleetErrorEnvelopeSchema,
  fleetImageMediaTypeSchema,
  type FleetErrorCode,
  type FleetAddApiKeyAccountRequest,
} from '@maestrly/bot-fleet-protocol'

export class FleetClientError extends Error {
  constructor(
    public readonly code: FleetErrorCode,
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'FleetClientError'
  }
}

type Routes = typeof FLEET_GATEWAY_ROUTES
type RouteKey = keyof Routes
type RouteResponse<K extends RouteKey> = Routes[K]['response'] extends { _output: infer T } ? T : void
/**
 * Lifecycle actions answer once the environment is done: after its container stops, or after its desktop answers
 * again (the gateway waits up to 240 s, after replacing the container when the server offers a newer image). A bot's
 * own start, stop and restart act on its environment when it is alone there.
 */
const LIFECYCLE_TIMEOUT_MS = 300_000
/** The gateway waits up to 30 s for sign-in pages and 60 s for a skill installation, for bots and environments. */
const SLOW_ROUTES: Partial<Record<RouteKey, number>> = {
  artifactUpload: 300_000,
  artifactAdmin: 60_000,
  botLoginStart: 35_000,
  environmentLoginStart: 35_000,
  botSkillInstall: 65_000,
  environmentSkillInstall: 65_000,
  environmentStart: LIFECYCLE_TIMEOUT_MS,
  environmentStop: LIFECYCLE_TIMEOUT_MS,
  environmentRestart: LIFECYCLE_TIMEOUT_MS,
  // A scheduled update answers at once; one done now waits for the restart.
  environmentUpdate: LIFECYCLE_TIMEOUT_MS,
  environmentArchive: LIFECYCLE_TIMEOUT_MS,
  botStart: LIFECYCLE_TIMEOUT_MS,
  botStop: LIFECYCLE_TIMEOUT_MS,
  botRestart: LIFECYCLE_TIMEOUT_MS,
  botArchive: LIFECYCLE_TIMEOUT_MS,
  archivedBotDelete: LIFECYCLE_TIMEOUT_MS,
  archivedEnvironmentDelete: LIFECYCLE_TIMEOUT_MS,
}

export class FleetApiClient {
  constructor(
    public readonly origin: string,
    private readonly token: string | null = null
  ) {}

  withToken(token: string): FleetApiClient {
    return new FleetApiClient(this.origin, token)
  }

  addApiKeyAccount(botId: string, body: FleetAddApiKeyAccountRequest) {
    return this.call('botApiKeyAccountAdd', { params: { id: botId }, body })
  }

  removeAccount(botId: string, providerId: string) {
    return this.call('botAccountRemove', { params: { id: botId, providerId } })
  }

  headers(): Record<string, string> {
    return {
      'X-Maestrly-Fleet-Protocol': String(FLEET_PROTOCOL_VERSION),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    }
  }

  async getFileMeta(botId: string, fileId: string, signal?: AbortSignal): Promise<FleetFileRef> {
    fleetFileIdSchema.parse(fileId)
    const ref = await this.call('botFileMeta', { params: { id: botId, fileId }, signal })
    if (ref.id !== fileId) throw new FleetClientError('INTERNAL', 200, 'Invalid file metadata')
    return ref
  }

  /** The caller must consume or cancel the response body. The signal covers the entire transfer. */
  async openFile(
    botId: string,
    fileId: string,
    signal?: AbortSignal
  ): Promise<{ ref: FleetFileRef; response: Response }> {
    const transferSignal = AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])])
    const ref = await this.getFileMeta(botId, fileId, transferSignal)
    let response: Response | undefined
    try {
      response = await fetch(this.origin + buildPath(FLEET_GATEWAY_ROUTES.botFile.path, { id: botId, fileId }), {
        headers: this.headers(),
        redirect: 'error',
        signal: transferSignal,
      })
      if (!response.ok) {
        const parsed = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
        throw new FleetClientError(
          parsed.success ? parsed.data.code : response.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
          response.status,
          parsed.success ? parsed.data.message : 'File unavailable'
        )
      }
      const length = response.headers.get('content-length')
      if (
        response.status !== 200 ||
        !response.body ||
        length === null ||
        !/^\d+$/.test(length) ||
        Number(length) !== ref.byteSize ||
        ref.byteSize > FLEET_FILE_LIMITS.downloadMaxBytes ||
        response.headers.get('content-type') !== ref.mediaType ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(ref.mediaType) ||
        (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')
      )
        throw new FleetClientError('INTERNAL', response.status, 'Invalid file response')
      const reader = response.body.getReader()
      let size = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            transferSignal.throwIfAborted()
            const next = await reader.read()
            if (next.done) {
              if (size !== ref.byteSize) throw new Error('Incomplete file')
              controller.close()
              reader.releaseLock()
              return
            }
            size += next.value.byteLength
            if (size > ref.byteSize) throw new Error('File too large')
            controller.enqueue(next.value)
          } catch (error) {
            await reader.cancel().catch(() => undefined)
            controller.error(error)
          }
        },
        async cancel(reason) {
          await reader.cancel(reason)
        },
      })
      return { ref, response: new Response(body, { headers: response.headers }) }
    } catch (error) {
      if (response && !response.bodyUsed) await response.body?.cancel().catch(() => undefined)
      if (error instanceof FleetClientError) throw error
      throw new FleetClientError('INSTANCE_UNAVAILABLE', 0, 'File download failed')
    }
  }

  async getImage(botId: string, imageId: string): Promise<{ mediaType: string; data: Uint8Array }> {
    let response: Response
    try {
      response = await fetch(this.origin + buildPath(FLEET_GATEWAY_ROUTES.botImage.path, { id: botId, imageId }), {
        headers: this.headers(),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new FleetClientError('INSTANCE_UNAVAILABLE', 0, 'Gateway unavailable')
    }
    if (!response.ok) {
      const parsed = fleetErrorEnvelopeSchema.safeParse(await response.json().catch(() => null))
      throw new FleetClientError(
        parsed.success ? parsed.data.code : response.status === 404 ? 'NOT_FOUND' : 'INSTANCE_UNAVAILABLE',
        response.status,
        parsed.success ? parsed.data.message : 'Image unavailable'
      )
    }
    const mediaType = response.headers.get('content-type')
    if (!fleetImageMediaTypeSchema.safeParse(mediaType).success)
      throw new FleetClientError('INTERNAL', response.status, 'Invalid image type')
    const declared = Number(response.headers.get('content-length'))
    if (
      !Number.isSafeInteger(declared) ||
      declared < 1 ||
      declared > FLEET_IMAGE_LIMITS.imageReadMaxBytes ||
      !response.body
    )
      throw new FleetClientError('INTERNAL', response.status, 'Invalid image size')
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        const part = next.value
        size += part.length
        if (size > declared || size > FLEET_IMAGE_LIMITS.imageReadMaxBytes)
          throw new FleetClientError('INTERNAL', response.status, 'Image too large')
        chunks.push(part)
      }
    } finally {
      reader.releaseLock()
    }
    if (size !== declared) throw new FleetClientError('INTERNAL', response.status, 'Incomplete image')
    const data = new Uint8Array(size)
    let offset = 0
    for (const part of chunks) {
      data.set(part, offset)
      offset += part.length
    }
    return { mediaType: mediaType!, data }
  }

  async call<K extends RouteKey>(
    key: K,
    options: {
      params?: Record<string, string | number>
      query?: Record<string, string | number | boolean | null | undefined>
      body?: unknown
      signal?: AbortSignal
    } = {}
  ): Promise<RouteResponse<K>> {
    const route = FLEET_GATEWAY_ROUTES[key]
    const path = buildPath(route.path, options.params, options.query)
    const headers = new Headers(this.headers())
    let body: string | undefined
    if (route.body) {
      body = JSON.stringify(route.body.parse(options.body))
      headers.set('Content-Type', 'application/json')
    }
    let response: Response
    try {
      response = await fetch(this.origin + path, {
        method: route.method,
        headers,
        body,
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(SLOW_ROUTES[key] ?? 15_000)])
          : AbortSignal.timeout(SLOW_ROUTES[key] ?? 15_000),
      })
    } catch (error) {
      throw new FleetClientError(
        'INSTANCE_UNAVAILABLE',
        0,
        error instanceof Error ? error.message : 'Gateway unavailable'
      )
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      const parsed = fleetErrorEnvelopeSchema.safeParse(payload)
      const fallback: FleetErrorCode =
        response.status === 401 ? 'UNAUTHORIZED' : response.status === 426 ? 'PROTOCOL_INCOMPATIBLE' : 'INTERNAL'
      throw new FleetClientError(
        parsed.success ? parsed.data.code : fallback,
        response.status,
        parsed.success ? parsed.data.message : 'Gateway request failed'
      )
    }
    if (!route.response) return undefined as RouteResponse<K>
    let json: unknown
    try {
      json = await response.json()
      if (key === 'meta' && (json as { protocol?: unknown }).protocol !== FLEET_PROTOCOL_VERSION) {
        throw new FleetClientError('PROTOCOL_INCOMPATIBLE', 426, 'Incompatible fleet protocol')
      }
      return route.response.parse(json) as RouteResponse<K>
    } catch (error) {
      if (error instanceof FleetClientError) throw error
      throw new FleetClientError('INTERNAL', response.status, 'Invalid gateway response')
    }
  }
}
