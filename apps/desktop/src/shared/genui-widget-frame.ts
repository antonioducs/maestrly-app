import {
  GENUI_WIDGET_BASE_CSS,
  GENUI_WIDGET_CSP,
  GENUI_WIDGET_THEME_KEYS,
  interfaceBridgeScript,
} from '@maestrly/bot-fleet-protocol'

// The page of the frame that renders an ```inline-html block. The main process serves it at GENUI_WIDGET_FRAME_URL.
// It waits for the block from its parent, then writes it as its own document under the frame's policy: the block
// keeps this opaque origin and policy, with no access to the app, its storage or the network. The policy, styles and
// bridge are shared with the mobile app's web view (@maestrly/bot-fleet-protocol).
export { GENUI_WIDGET_BASE_CSS, GENUI_WIDGET_CDN_SOURCES, GENUI_WIDGET_CSP } from '@maestrly/bot-fleet-protocol'

const BRIDGE = interfaceBridgeScript('parent')

/**
 * Accepts the first render message from the window that frames it. A chat in a separate window is drawn by the main
 * window's renderer, which then posts the block: the opener of the framing window counts too.
 */
const SHELL = `(function () {
  'use strict';
  var BRIDGE = ${JSON.stringify(BRIDGE)};
  var BASE_CSS = ${JSON.stringify(GENUI_WIDGET_BASE_CSS)};
  var KEYS = ${JSON.stringify(GENUI_WIDGET_THEME_KEYS)};
  var SAFE_VALUE = /^[^;{}<>\\\\]{1,200}$/;
  var trusted = [window.parent, window.top];
  try { if (window.top.opener) trusted.push(window.top.opener); } catch (error) {}
  function onMessage(event) {
    if (trusted.indexOf(event.source) < 0) return;
    var data = event.data;
    if (!data || data.source !== 'maestrly-host' || data.type !== 'render' || typeof data.html !== 'string') return;
    window.removeEventListener('message', onMessage);
    var theme = data.theme && typeof data.theme === 'object' ? data.theme : {};
    var vars = '';
    KEYS.forEach(function (key) {
      var value = theme[key];
      if (typeof value === 'string' && SAFE_VALUE.test(value)) vars += '--ui-' + key + ':' + value + ';';
    });
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><style>' + BASE_CSS + (vars ? ':root{' + vars + '}' : '') +
      '</style><script>' + BRIDGE + '<\\/script></head><body>' + data.html + '</body></html>');
    document.close();
  }
  window.addEventListener('message', onMessage);
  window.parent.postMessage({ source: 'maestrly-widget', type: 'ready' }, '*');
})();`

export const GENUI_WIDGET_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body><script>${SHELL}</script></body></html>`

export function genUiWidgetFrameHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': GENUI_WIDGET_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

/** The response to a request of the frame scheme: the page at its one URL, nothing else. */
export function genUiWidgetFrameResponse(request: { method: string; url: string }): {
  status: number
  headers: Record<string, string>
  body: string
} {
  let url: URL | null = null
  try {
    url = new URL(request.url)
  } catch {
    url = null
  }
  if (request.method !== 'GET' || !url || url.host !== 'frame' || url.pathname !== '/' || url.search)
    return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' }
  return { status: 200, headers: genUiWidgetFrameHeaders(), body: GENUI_WIDGET_FRAME_HTML }
}
