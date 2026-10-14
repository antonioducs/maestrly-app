import { GENUI_WIDGET_MAX_HEIGHT, GENUI_WIDGET_THEME_KEYS } from './genui-widget'

// The page of the frame that renders an ```inline-html block. The main process serves it at GENUI_WIDGET_FRAME_URL.
// It waits for the block from its parent, then writes it as its own document under the policy below: the block keeps
// this opaque origin and policy, with no access to the app, its storage or the network.

/** Third-party origins a block may load libraries, styles and fonts from (the artifact allowlist). */
export const GENUI_WIDGET_CDN_SOURCES = 'https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com'

/**
 * No fetch, XHR, WebSocket, frames, forms or plugins. Images and media load from any https host: showing pictures
 * from the web is the point of these blocks, and it means what a block names in those URLs reaches their hosts.
 */
export const GENUI_WIDGET_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${GENUI_WIDGET_CDN_SOURCES}`,
  `style-src 'unsafe-inline' ${GENUI_WIDGET_CDN_SOURCES} https://fonts.googleapis.com`,
  'img-src https: data: blob:',
  'media-src https: data: blob:',
  `font-src data: https://fonts.gstatic.com ${GENUI_WIDGET_CDN_SOURCES}`,
  "connect-src 'none'",
  'worker-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * The stylesheet written before every block: plain elements get the app's type, spacing, tables and controls. Each
 * rule sits in :where(), with no specificity, so any style of the block wins.
 */
export const GENUI_WIDGET_BASE_CSS = [
  // Theme variables; the host sends the app's current values over them.
  ':root{color-scheme:dark;--ui-text:rgba(237,234,227,.96);--ui-muted:rgba(154,149,140,.85);',
  '--ui-card:rgba(255,255,255,.03);--ui-border:rgba(255,255,255,.08);--ui-accent:#edeae3;--ui-accent-text:#0a0a0b;',
  '--ui-success:#34d399;--ui-warning:#fbbf24;--ui-danger:#ff7a85;',
  '--ui-font:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--ui-mono:ui-monospace,SFMono-Regular,Menlo,monospace;',
  '--ui-radius:12px}',
  '*,*::before,*::after{box-sizing:border-box}html,body{margin:0;background:transparent}',
  // The frame grows with its content, so it never scrolls down (the bridge lets a block past the maximum height
  // scroll). A classic scrollbar would narrow the page, and content whose height follows its width, such as images
  // with an aspect ratio, would then keep it for good.
  ':where(html){overflow-y:hidden}',
  // The padding keeps the borders, shadows and focus rings of the outermost elements inside the frame.
  'body{padding:2px;color:var(--ui-text);font:14px/1.5 var(--ui-font);overflow-wrap:break-word}',
  ':where(h1,h2,h3,h4,h5,h6){margin:0 0 .5em;font-weight:600;line-height:1.25}',
  ':where(h1){font-size:1.45em}:where(h2){font-size:1.2em}:where(h3){font-size:1.05em}:where(h4,h5,h6){font-size:1em}',
  ':where(p,ul,ol,dl,blockquote,pre,table,figure,.ui-scroll){margin:0 0 .75em}',
  ':where(:is(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,blockquote,pre,table,figure,.ui-scroll):last-child){margin-bottom:0}',
  ':where(ul,ol){padding-left:1.3em}:where(li+li){margin-top:.25em}',
  ':where(a){color:var(--ui-accent);text-underline-offset:2px}:where(strong,b){font-weight:600}:where(small){font-size:12px}',
  ':where(code,kbd,samp,pre){font-family:var(--ui-mono);font-size:.9em}',
  ':where(:not(pre)>code){padding:.1em .35em;border-radius:5px;background:rgba(255,255,255,.07)}',
  ':where(pre){padding:10px 12px;overflow-x:auto;border:1px solid var(--ui-border);border-radius:8px;background:rgba(0,0,0,.25)}',
  ':where(hr){height:1px;margin:12px 0;border:0;background:var(--ui-border)}',
  ':where(blockquote){margin-left:0;padding-left:12px;border-left:2px solid var(--ui-border);color:var(--ui-muted)}',
  ':where(img,video,canvas){max-width:100%;height:auto;vertical-align:middle}:where(svg){max-width:100%;vertical-align:middle}',
  ':where(table){width:100%;border-collapse:collapse;font-size:13px}',
  ':where(th,td){padding:6px 10px;border-bottom:1px solid var(--ui-border);text-align:left;vertical-align:top}',
  ':where(th){color:var(--ui-muted);font-size:12px;font-weight:500}:where(tr:last-child>td){border-bottom:0}',
  ':where(button,input,select,textarea){font:inherit;color:inherit}',
  ':where(button){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;',
  'padding:0 12px;border:1px solid var(--ui-border);border-radius:8px;background:rgba(255,255,255,.04);',
  'color:var(--ui-text);font-size:13px;font-weight:500;line-height:1.2;text-decoration:none;cursor:pointer}',
  ':where(button:hover){background:rgba(255,255,255,.08)}',
  ':where(button:disabled){opacity:.5;cursor:default}',
  ':where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file]),select,textarea){',
  'min-height:32px;max-width:100%;padding:6px 10px;border:1px solid var(--ui-border);border-radius:8px;',
  'background:rgba(0,0,0,.2);color:var(--ui-text)}',
  ':where(textarea){resize:vertical}',
  ':where(input[type=checkbox],input[type=radio],input[type=range]){accent-color:var(--ui-accent)}',
  ':where(:is(button,input,select,textarea):focus-visible){outline:2px solid var(--ui-accent);outline-offset:1px}',
  // The bridge wraps a table or code block wider than the answer in it.
  ':where(.ui-scroll){max-width:100%;overflow-x:auto}',
  // An image that did not load keeps its box and shows a placeholder (see the bridge).
  'img[data-ui-failed]{object-fit:contain!important;background:rgba(255,255,255,.04)}',
].join('')

/** What a failed image shows instead: a neutral picture frame, sized 4:3 when the block gives it no size. */
const IMAGE_PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">' +
  '<g fill="none" stroke="rgba(237,234,227,0.35)" stroke-width="2.5" stroke-linejoin="round">' +
  '<rect x="60" y="44" width="40" height="32" rx="4"/><path d="M64 70l10-10 8 8 5-5 9 9"/></g>' +
  '<circle cx="90" cy="53" r="3" fill="rgba(237,234,227,0.35)"/></svg>'

/**
 * Runs first in the written document: reports its height, sends links and maestrly.send/openLink to the host, and
 * replaces the storage an opaque origin refuses with one that lasts until the page reloads.
 *
 * It also checks the block, since the model writes it without seeing it: an image that fails is replaced by a
 * placeholder, a wide table or code block gets a horizontal scroll, and what it cannot fix (content wider than the
 * answer, text cut off by a fixed height, a layout that grows with the frame, script errors, blocked requests) is
 * reported once to the host as an issue.
 */
const BRIDGE = `(function () {
  'use strict';
  var host = window.parent;
  function post(message) {
    message.source = 'maestrly-widget';
    try { host.postMessage(message, '*'); } catch (error) {}
  }
  function memoryStorage() {
    var items = new Map();
    return {
      get length() { return items.size; },
      key: function (index) { var keys = Array.from(items.keys()); return index >= 0 && index < keys.length ? keys[index] : null; },
      getItem: function (key) { key = String(key); return items.has(key) ? items.get(key) : null; },
      setItem: function (key, value) { items.set(String(key), String(value)); },
      removeItem: function (key) { items.delete(String(key)); },
      clear: function () { items.clear(); }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    try { void window[name].length; } catch (error) {
      try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (ignored) {}
    }
  });
  Object.defineProperty(window, 'maestrly', {
    value: Object.freeze({
      send: function (text) { post({ type: 'send', text: String(text) }); },
      openLink: function (url) { post({ type: 'open', url: String(url) }); }
    })
  });
  document.addEventListener('click', function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    event.preventDefault();
    post({ type: 'open', url: link.href });
  }, true);
  var reported = Object.create(null);
  var issueCount = 0;
  function issue(kind, detail) {
    detail = String(detail || '').slice(0, 300);
    var key = kind + ' ' + detail;
    if (reported[key] || issueCount >= 20) return;
    reported[key] = true;
    issueCount += 1;
    post({ type: 'issue', kind: kind, detail: detail });
  }
  // div#row > div: an element without an id or a class is named after its parent too.
  function describe(element, depth) {
    var name = element.tagName.toLowerCase();
    var plain = true;
    if (element.id) { name += '#' + element.id; plain = false; }
    if (typeof element.className === 'string') {
      element.className.split(/\\s+/).filter(Boolean).slice(0, 2).forEach(function (item) { name += '.' + item; plain = false; });
    }
    var parent = element.parentElement;
    if (plain && parent && parent !== document.body && (depth || 0) < 2) return describe(parent, (depth || 0) + 1) + ' > ' + name;
    return name;
  }

  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(${JSON.stringify(IMAGE_PLACEHOLDER)});
  document.addEventListener('error', function (event) {
    var image = event.target;
    if (!image || image.tagName !== 'IMG' || image.hasAttribute('data-ui-failed')) return;
    var source = image.currentSrc || image.getAttribute('src') || '';
    if (!source) return;
    image.setAttribute('data-ui-failed', '');
    image.removeAttribute('srcset');
    var picture = image.parentElement;
    if (picture && picture.tagName === 'PICTURE') {
      Array.prototype.slice.call(picture.querySelectorAll('source')).forEach(function (item) { item.remove(); });
    }
    image.src = PLACEHOLDER;
    issue('image', source);
  }, true);
  window.addEventListener('error', function (event) {
    if (event.message) issue('script', event.message);
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    issue('script', reason && reason.message ? reason.message : String(reason));
  });
  document.addEventListener('securitypolicyviolation', function (event) {
    issue('blocked', (event.effectiveDirective || event.violatedDirective) + ' ' + (event.blockedURI || ''));
  });

  var root = document.documentElement;
  function scrolledAway(element) {
    for (var node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).overflowX !== 'visible') return true;
    }
    return false;
  }
  function widest() {
    if (!document.body || root.scrollWidth <= root.clientWidth + 1) return null;
    var limit = root.clientWidth + 1;
    var elements = document.body.getElementsByTagName('*');
    for (var i = 0; i < elements.length && i < 3000; i += 1) {
      var element = elements[i];
      var box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= limit) continue;
      var parent = element.parentElement;
      if (parent && parent !== document.body && parent.getBoundingClientRect().right > limit) continue;
      if (!scrolledAway(element)) return element;
    }
    return null;
  }
  // Wrapping a table rarely changes the page's height, so no later check would look again: keep looking here.
  function checkWidth() {
    for (var attempt = 0; attempt < 10; attempt += 1) {
      var element = widest();
      if (!element) return;
      var wide = element.closest('table, pre');
      if (!wide || !wide.parentNode || (wide.parentElement && wide.parentElement.classList.contains('ui-scroll'))) {
        issue('overflow', describe(element));
        return;
      }
      var wrapper = document.createElement('div');
      wrapper.className = 'ui-scroll';
      wide.parentNode.insertBefore(wrapper, wide);
      wrapper.appendChild(wide);
    }
  }
  function cutsText(element) {
    var style = getComputedStyle(element);
    if ((style.overflowY !== 'hidden' && style.overflowY !== 'clip') || style.textOverflow === 'ellipsis') return false;
    if (style.webkitLineClamp && style.webkitLineClamp !== 'none') return false;
    if (element.scrollHeight <= element.clientHeight + 2) return false;
    var box = element.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) return false;
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    var range = document.createRange();
    for (var count = 0, node = walker.nextNode(); node && count < 200; node = walker.nextNode(), count += 1) {
      if (!node.nodeValue.trim()) continue;
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var j = 0; j < rects.length; j += 1) if (rects[j].width > 0 && rects[j].bottom > box.bottom + 2) return true;
    }
    return false;
  }
  function checkClipping() {
    if (!document.body) return;
    var elements = document.body.getElementsByTagName('*');
    for (var i = 0; i < elements.length && i < 1500; i += 1) {
      var element = elements[i];
      if (/^(img|video|canvas|svg|iframe|script|style)$/i.test(element.tagName)) continue;
      if (cutsText(element)) issue('clipped', describe(element));
    }
  }
  // The first check after the page loaded tells the host it is done: a preview waits for it before its screenshot.
  var loadedPending = false;
  function check() {
    checkWidth();
    checkClipping();
    if (loadedPending) {
      loadedPending = false;
      post({ type: 'loaded' });
    }
  }

  var last = -1;
  var lastWidth = window.innerWidth;
  var viewportBound = 0;
  var frozen = false;
  var checkTimer = 0;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(check, 400);
  }
  function measure() {
    var body = document.body;
    var height = Math.max(root.getBoundingClientRect().height, body ? body.scrollHeight : 0);
    // A horizontal scrollbar takes its height from the frame; asking for it too keeps a vertical one away.
    return Math.ceil(height + Math.max(0, window.innerHeight - root.clientHeight));
  }
  function report(fromResize) {
    if (frozen) return;
    var height = measure();
    root.style.overflowY = height > ${GENUI_WIDGET_MAX_HEIGHT} ? 'auto' : '';
    if (height === last) return;
    // The host only applied the height asked for, and the content followed it: it is sized by the frame's own height
    // (100vh, height: 100%), so each report would grow it again. Keep the last height instead.
    viewportBound = fromResize === true && window.innerWidth === lastWidth && last >= 0 ? viewportBound + 1 : 0;
    if (viewportBound >= 3) {
      frozen = true;
      issue('viewport', '');
      return;
    }
    last = height;
    lastWidth = window.innerWidth;
    post({ type: 'size', height: height });
    scheduleCheck();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(function () { report(false); }).observe(root);
  document.addEventListener('DOMContentLoaded', function () { report(false); });
  window.addEventListener('load', function () {
    loadedPending = true;
    report(false);
    scheduleCheck();
  });
  window.addEventListener('resize', function () { report(true); });
})();`

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
