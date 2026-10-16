/// <reference path="../../types/novnc.d.ts" />
/**
 * Load noVNC's keyboard module only when a bot screen is opened, never at app startup.
 *
 * The module brings noVNC's `browser.js`, which probes hardware H.264 decoding while it evaluates (a top-level await
 * that creates a WebCodecs `VideoDecoder` and never closes it). The keyboard does not need the probe, so the
 * constructor is hidden while the module evaluates and restored as soon as the import settles; the screens' own
 * decoders are created afterwards.
 */
type KeyboardModule = typeof import('@novnc/novnc/core/input/keyboard.js')

let loading: Promise<KeyboardModule> | null = null

export function loadScreenKeyboard(): Promise<KeyboardModule> {
  loading ??= importWithoutVideoDecoder().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

async function importWithoutVideoDecoder(): Promise<KeyboardModule> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'VideoDecoder')
  const hide = descriptor?.configurable === true
  if (hide) Reflect.deleteProperty(globalThis, 'VideoDecoder')
  try {
    return await import('@novnc/novnc/core/input/keyboard.js')
  } finally {
    if (hide && descriptor) Object.defineProperty(globalThis, 'VideoDecoder', descriptor)
  }
}
