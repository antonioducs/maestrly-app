/// <reference path="../../types/novnc.d.ts" />
/**
 * Load noVNC only when a bot screen is opened, never at app startup.
 *
 * noVNC probes hardware H.264 decoding while its module evaluates (a top-level await that creates a WebCodecs
 * `VideoDecoder` and never closes it). Bot screens come from x11vnc, which never sends H.264, so the probe
 * buys nothing and leaves a live hardware decoder in the renderer. Hiding the constructor while the module
 * evaluates makes noVNC skip the probe; it is restored as soon as the import settles.
 */
type NoVncModule = typeof import('@novnc/novnc')

let loading: Promise<NoVncModule> | null = null

export function loadNoVnc(): Promise<NoVncModule> {
  loading ??= importWithoutVideoDecoder().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

async function importWithoutVideoDecoder(): Promise<NoVncModule> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder')
  const hide = descriptor?.configurable === true
  if (hide) Reflect.deleteProperty(globalThis, 'VideoDecoder')
  try {
    return await import('@novnc/novnc')
  } finally {
    if (hide && descriptor) Object.defineProperty(globalThis, 'VideoDecoder', descriptor)
  }
}
