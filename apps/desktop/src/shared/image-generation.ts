/** Which subscription draws `generate_image` images; shared by the main process (router, settings IPC) and the UI. */
export const IMAGE_GEN_PROVIDERS = ['auto', 'chatgpt', 'google'] as const
export type ImageGenProvider = (typeof IMAGE_GEN_PROVIDERS)[number]

export function isImageGenProvider(value: unknown): value is ImageGenProvider {
  return typeof value === 'string' && (IMAGE_GEN_PROVIDERS as readonly string[]).includes(value)
}
