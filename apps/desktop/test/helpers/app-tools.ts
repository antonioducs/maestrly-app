/**
 * Loads the app tools registry and the six hundred or so modules it reaches. Without it, the first turn of a test that
 * builds app tools pays for that inside its own timeout, which a busy machine overruns.
 */
export async function preloadAppToolsRegistry(): Promise<void> {
  await import('../../src/main/app-tools-registry')
}

/** Long enough for a machine under heavy load; a quiet one needs a few seconds. */
export const PRELOAD_APP_TOOLS_TIMEOUT_MS = 120_000
