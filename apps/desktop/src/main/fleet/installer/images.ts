/**
 * The bot server images for this app. A packaged app installs the images the release published for its own version;
 * a development build uses the ones `scripts/bot-fleet-images.mjs` builds from the checkout. Environment variables
 * point either at another registry or tag, for tests and for checking an install before a release.
 */

/** The release workflow publishes under the repository owner, the same owner the app updates from. */
export const BOT_SERVER_REGISTRY = 'ghcr.io/antonioducs'

export interface BotServerImages {
  gateway: string
  bot: string
  /** `registry`: pulled; `local`: already on this computer, or built from the checkout. */
  source: 'registry' | 'local'
}

const registryPattern = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export function botServerImages(input: {
  version: string
  isPackaged: boolean
  env: NodeJS.ProcessEnv
}): BotServerImages {
  const registryOverride = input.env.MAESTRLY_BOT_SERVER_REGISTRY?.trim().replace(/\/+$/, '') || null
  const tagOverride = input.env.MAESTRLY_BOT_SERVER_TAG?.trim() || null
  if (registryOverride !== null && !registryPattern.test(registryOverride))
    throw new Error('MAESTRLY_BOT_SERVER_REGISTRY is not a registry reference')
  if (tagOverride !== null && !tagPattern.test(tagOverride))
    throw new Error('MAESTRLY_BOT_SERVER_TAG is not an image tag')
  if (registryOverride !== null || input.isPackaged) {
    const registry = registryOverride ?? BOT_SERVER_REGISTRY
    const tag = tagOverride ?? input.version
    if (!tagPattern.test(tag)) throw new Error('The app version is not an image tag')
    return {
      gateway: `${registry}/maestrly-bot-gateway:${tag}`,
      bot: `${registry}/maestrly-bot-instance:${tag}`,
      source: 'registry',
    }
  }
  const tag = tagOverride ?? 'local'
  return { gateway: `maestrly/bot-gateway:${tag}`, bot: `maestrly/bot-instance:${tag}`, source: 'local' }
}
