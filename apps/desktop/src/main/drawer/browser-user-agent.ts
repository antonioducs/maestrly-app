/**
 * The user agent the embedded browser presents to websites. Electron's default adds the app's own `<name>/<version>`
 * product and `Electron/<version>` to Chromium's string, and sign-in pages and bot checks refuse that as an embedded
 * browser. Websites get Chromium's own string instead, with the major-only Chrome version Chromium itself sends.
 */
export function websiteUserAgent(electronUserAgent: string): string {
  return electronUserAgent
    .replace(/\s+Electron\/\S+/i, '')
    .replace(/\(KHTML, like Gecko\).*?\s(Chrome\/)/, '(KHTML, like Gecko) $1')
    .replace(/\bChrome\/(\d+)(?:\.\d+)+/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
