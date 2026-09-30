import { SHELL_VERSION } from '../generated/shell-assets.js'

/** The viewer document is identical for every artifact and state; it loads everything else from the API. */
export const shellDocument = (): string => {
  const base = `/_maestrly/shell/${SHELL_VERSION}`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Maestrly</title><link rel="stylesheet" href="${base}/viewer.css"><script type="module" src="${base}/viewer.js"></script></head><body><div id="app"></div></body></html>`
}
