/**
 * The page that shows a bot's screen on the phone, in a web view of its own (an iframe in the web build). It decodes
 * the screen's H.264 frames with WebCodecs and draws them on a canvas, and turns the owner's touches into pan, zoom,
 * taps and scrolls of the remote screen. It has no network and no secrets: the app holds the WebSocket and the ticket,
 * and the two talk only through messages, each checked by its reader.
 */

/**
 * What the app tells the page, as JSON. Frames travel as base64, the only form a web view's messages carry. A web view
 * hands each to `window.maestrlyScreen`; the web build's frame posts it as a message from its parent.
 */
export type ScreenPageCommand =
  | { t: 'labels'; stop: string }
  | { t: 'mode'; mode: 'view' | 'control' }
  /** A new stream of a `w`×`h` screen; its frame ids start over. */
  | { t: 'open'; w: number; h: number }
  | { t: 'frame'; id: number; key: boolean; codec: string; data: string }
  | { t: 'picture'; uri: string }
  /** The bot's pointer, for viewers: -1, -1 when it is off the screen. */
  | { t: 'pointer'; x: number; y: number }
  /** Frames the area around the bot's pointer, or the whole screen when the page knows no pointer. */
  | { t: 'focus' }
  | { t: 'fit' }

/** What the page tells the app; `parseScreenPageMessage` reads it. */
export type ScreenPageMessage =
  /** The page runs; `video` says whether it can decode frames. */
  | { t: 'ready'; video: boolean }
  | { t: 'decoded'; id: number }
  | { t: 'failed' }
  | { t: 'fatal'; reason: 'unsupported' | 'decoder' }
  /** A tap on the remote screen, in its pixels, while controlling it. */
  | { t: 'tap'; x: number; y: number }
  /** A tap while only watching. */
  | { t: 'watch' }
  /** Whole wheel steps at a point of the remote screen, while controlling it. */
  | { t: 'scroll'; x: number; y: number; dx: number; dy: number }
  /** The page knows where the bot's pointer is (`stop`), and whether the whole screen is in view (`fit`). */
  | { t: 'view'; stop: boolean; fit: boolean }

export type ScreenPageTransport = 'react-native' | 'parent'

const POSITION_MAX = 100_000
const STEPS_MAX = 20
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/** A message from the page, or null for anything else. */
export function parseScreenPageMessage(data: unknown): ScreenPageMessage | null {
  if (typeof data === 'string') {
    try {
      return parseScreenPageMessage(JSON.parse(data))
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  const m = data as Record<string, unknown>
  switch (m.t) {
    case 'ready':
      return typeof m.video === 'boolean' ? { t: 'ready', video: m.video } : null
    case 'decoded':
      return isInt(m.id, 0, Number.MAX_SAFE_INTEGER) ? { t: 'decoded', id: m.id } : null
    case 'failed':
    case 'watch':
      return { t: m.t }
    case 'fatal':
      return m.reason === 'unsupported' || m.reason === 'decoder' ? { t: 'fatal', reason: m.reason } : null
    case 'tap':
      return isInt(m.x, 0, POSITION_MAX) && isInt(m.y, 0, POSITION_MAX) ? { t: 'tap', x: m.x, y: m.y } : null
    case 'scroll':
      return isInt(m.x, 0, POSITION_MAX) &&
        isInt(m.y, 0, POSITION_MAX) &&
        isInt(m.dx, -STEPS_MAX, STEPS_MAX) &&
        isInt(m.dy, -STEPS_MAX, STEPS_MAX)
        ? { t: 'scroll', x: m.x, y: m.y, dx: m.dx, dy: m.dy }
        : null
    case 'view':
      return typeof m.stop === 'boolean' && typeof m.fit === 'boolean' ? { t: 'view', stop: m.stop, fit: m.fit } : null
    default:
      return null
  }
}

/** The page loads nothing: its script and styles are inline, and pictures arrive as data URLs. */
export const SCREEN_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

/**
 * The view's geometry, as plain functions of the page (tests run them as they are). A view is a scale and the
 * screen's offset in the port; a port and a screen are sizes, a rect a part of the screen.
 */
export const SCREEN_VIEWPORT_SOURCE = `
var MAX_SCALE = 2.5;
function fitScale(port, size) {
  return Math.min(port.w / size.w, port.h / size.h);
}
function clampView(v, port, size) {
  var s = Math.min(MAX_SCALE, Math.max(fitScale(port, size), v.s));
  var w = size.w * s;
  var h = size.h * s;
  return {
    s: s,
    tx: w <= port.w ? (port.w - w) / 2 : Math.min(0, Math.max(port.w - w, v.tx)),
    ty: h <= port.h ? (port.h - h) / 2 : Math.min(0, Math.max(port.h - h, v.ty))
  };
}
function fitView(port, size) {
  return clampView({ s: 0, tx: 0, ty: 0 }, port, size);
}
function rectView(rect, port, size) {
  // A tenth of the rect's size as room on each side, so its frame does not touch the port's edges.
  var s = Math.min(port.w / (rect.w * 1.2), port.h / (rect.h * 1.2), 1.4);
  return clampView({ s: s, tx: port.w / 2 - (rect.x + rect.w / 2) * s, ty: port.h / 2 - (rect.y + rect.h / 2) * s }, port, size);
}
function zoomAround(v, p, s, port, size) {
  var rx = (p.x - v.tx) / v.s;
  var ry = (p.y - v.ty) / v.s;
  return clampView({ s: s, tx: p.x - rx * s, ty: p.y - ry * s }, port, size);
}
function centerOn(v, point, port, size) {
  return clampView({ s: v.s, tx: port.w / 2 - point.x * v.s, ty: port.h / 2 - point.y * v.s }, port, size);
}
function stopRect(point, size) {
  var w = Math.min(360, size.w);
  var h = Math.min(225, size.h);
  return {
    x: Math.min(Math.max(0, point.x - w / 2), size.w - w),
    y: Math.min(Math.max(0, point.y - h / 2), size.h - h),
    w: w,
    h: h
  };
}
function remotePoint(v, p) {
  return { x: (p.x - v.tx) / v.s, y: (p.y - v.ty) / v.s };
}
`

/**
 * The WebCodecs side of the page, as the desktop's ScreenFrameDecoder: H.264 access units in, pictures out, and
 * acknowledgements once drawn. The frame id travels as the chunk's timestamp; a decoder that fails is replaced at the
 * next frame, and the frames it held are acknowledged as lost.
 */
export const SCREEN_DECODER_SOURCE = `
var DECODER_FAILURES_MAX = 5;
function createDecoder(o) {
  var decoder = null;
  var codec = null;
  var failures = 0;
  var decoding = [];
  var acknowledged = -1;
  var closed = false;
  function acknowledge(id) {
    if (closed || id <= acknowledged) return;
    acknowledged = id;
    o.decoded(id);
  }
  function reset() {
    var d = decoder;
    decoder = null;
    codec = null;
    decoding = [];
    if (d && d.state !== 'closed') {
      try { d.close(); } catch (error) {}
    }
  }
  function failed(d) {
    if (d !== decoder || closed) return;
    var last = decoding[decoding.length - 1];
    reset();
    if (last !== undefined) acknowledge(last);
    if (++failures >= DECODER_FAILURES_MAX) {
      o.fatal('decoder');
      return;
    }
    o.failed();
  }
  function output(picture, d) {
    var id = picture.timestamp;
    if (d !== decoder || closed) {
      picture.close();
      return;
    }
    failures = 0;
    decoding = decoding.filter(function (pending) { return pending > id; });
    try { o.picture(picture); } catch (error) {}
    try { picture.close(); } catch (error) {}
    acknowledge(id);
  }
  return {
    decode: function (frame) {
      if (closed) return;
      if (typeof VideoDecoder !== 'function') {
        acknowledge(frame.id);
        o.fatal('unsupported');
        return;
      }
      if (!decoder || decoder.state === 'closed' || codec !== frame.codec) {
        reset();
        var made = new VideoDecoder({
          output: function (picture) { output(picture, made); },
          error: function () { failed(made); }
        });
        decoder = made;
        codec = frame.codec;
        try {
          made.configure({ codec: frame.codec, optimizeForLatency: true });
        } catch (error) {
          acknowledge(frame.id);
          failed(made);
          return;
        }
      }
      var current = decoder;
      decoding.push(frame.id);
      try {
        current.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.id, data: frame.data }));
      } catch (error) {
        failed(current);
      }
    },
    restart: function () {
      reset();
      acknowledged = -1;
      failures = 0;
    },
    close: function () {
      closed = true;
      reset();
    }
  };
}
`

const HOSTS: Record<ScreenPageTransport, string> = {
  'react-native': `
  function post(message) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } catch (error) {}
  }
  function listen(handle) {
    // The app calls this one function (injectJavaScript): a web view's own message events reach the page on window or
    // on document depending on the platform, sometimes on both.
    Object.defineProperty(window, 'maestrlyScreen', {
      value: function (text) { if (typeof text === 'string') handle(text); }
    });
  }`,
  parent: `
  function post(message) {
    try { window.parent.postMessage(message, '*'); } catch (error) {}
  }
  function listen(handle) {
    window.addEventListener('message', function (event) {
      if (event.source === window.parent && typeof event.data === 'string') handle(event.data);
    });
  }`,
}

const SCRIPT = `
  var canvas = document.getElementById('screen');
  var context = canvas.getContext('2d', { alpha: false });
  var portElement = document.getElementById('port');
  var reticle = document.getElementById('reticle');
  var label = document.getElementById('label');
  var ripples = document.getElementById('ripples');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var size = { w: canvas.width, h: canvas.height };
  var port = { w: 1, h: 1 };
  var view = { s: 1, tx: 0, ty: 0 };
  var mode = 'view';
  var stop = null;
  var anchor = null;
  var moved = false;
  var focused = false;
  var lastView = '';
  var decoder = createDecoder({
    decoded: function (id) { post({ t: 'decoded', id: id }); },
    failed: function () { post({ t: 'failed' }); },
    fatal: function (reason) { post({ t: 'fatal', reason: reason }); },
    picture: function (picture) { context.drawImage(picture, 0, 0, size.w, size.h); }
  });

  function bytes(base64) {
    var text = atob(base64);
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
  function measure() {
    port = { w: Math.max(1, portElement.clientWidth), h: Math.max(1, portElement.clientHeight) };
  }
  function report() {
    var fit = view.s <= fitScale(port, size) + 0.001;
    var key = (stop ? 1 : 0) + ':' + (fit ? 1 : 0);
    if (key === lastView) return;
    lastView = key;
    post({ t: 'view', stop: !!stop, fit: fit });
  }
  function paint() {
    canvas.style.transform = 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.s + ')';
    if (stop && (mode === 'view' || !anchor)) {
      var rect = stopRect(stop, size);
      var x = view.tx + rect.x * view.s;
      var y = view.ty + rect.y * view.s;
      reticle.style.left = x + 'px';
      reticle.style.top = y + 'px';
      reticle.style.width = rect.w * view.s + 'px';
      reticle.style.height = rect.h * view.s + 'px';
      reticle.className = 'on' + (y < 30 ? ' below' : '');
    } else reticle.className = '';
    report();
  }
  var tween = 0;
  function animate(to, ms) {
    cancelAnimationFrame(tween);
    if (reduce || !ms) {
      view = to;
      paint();
      return;
    }
    var from = view;
    var start = performance.now();
    function step(now) {
      var p = Math.min(1, (now - start) / ms);
      var e = 1 - Math.pow(1 - p, 3);
      view = { s: from.s + (to.s - from.s) * e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e };
      paint();
      if (p < 1) tween = requestAnimationFrame(step);
    }
    tween = requestAnimationFrame(step);
  }
  function focusStop(ms) {
    animate(stop ? rectView(stopRect(stop, size), port, size) : fitView(port, size), ms);
  }
  function ripple(p, watching) {
    var node = document.createElement('span');
    node.className = watching ? 'ripple watching' : 'ripple';
    node.style.left = p.x + 'px';
    node.style.top = p.y + 'px';
    ripples.appendChild(node);
    setTimeout(function () { node.remove(); }, 600);
  }

  // Gestures: one finger pans, two pinch (or scroll the remote screen while controlling it), a tap clicks there.
  var pointers = new Map();
  var gesture = null;
  var lastTap = { at: 0, x: 0, y: 0 };
  var watchTimer = 0;
  function local(event) {
    var box = portElement.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }
  function middle(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function inside(r) { return r.x >= 0 && r.y >= 0 && r.x < size.w && r.y < size.h; }
  function clampPoint(r) {
    return { x: Math.min(size.w - 1, Math.max(0, Math.round(r.x))), y: Math.min(size.h - 1, Math.max(0, Math.round(r.y))) };
  }
  portElement.addEventListener('pointerdown', function (event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    try { portElement.setPointerCapture(event.pointerId); } catch (error) {}
    pointers.set(event.pointerId, local(event));
    cancelAnimationFrame(tween);
    if (pointers.size === 1) gesture = { kind: 'press', start: local(event), from: view };
    else if (pointers.size === 2) {
      var two = Array.from(pointers.values());
      var m = middle(two[0], two[1]);
      gesture = { kind: 'two', d0: Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1, m0: m, last: m, from: view, rest: 0 };
    }
  });
  portElement.addEventListener('pointermove', function (event) {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, local(event));
    if (gesture.kind === 'two' || gesture.kind === 'pinch' || gesture.kind === 'scroll') {
      if (pointers.size < 2) return;
      var two = Array.from(pointers.values());
      var m = middle(two[0], two[1]);
      var ratio = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) / gesture.d0;
      if (gesture.kind === 'two') {
        // Controlling the screen, two fingers that move together scroll it; spreading them zooms.
        if (mode !== 'control' || Math.abs(ratio - 1) > 0.08) gesture.kind = 'pinch';
        else if (Math.hypot(m.x - gesture.m0.x, m.y - gesture.m0.y) > 14) gesture.kind = 'scroll';
        else return;
      }
      if (gesture.kind === 'pinch') {
        var g = gesture;
        var s = g.from.s * ratio;
        var rx = (g.m0.x - g.from.tx) / g.from.s;
        var ry = (g.m0.y - g.from.ty) / g.from.s;
        view = clampView({ s: s, tx: m.x - rx * s, ty: m.y - ry * s }, port, size);
        moved = true;
        paint();
        return;
      }
      gesture.rest += gesture.last.y - m.y;
      gesture.last = m;
      var steps = Math.trunc(gesture.rest / 40);
      if (steps) {
        gesture.rest -= steps * 40;
        var at = clampPoint(remotePoint(view, m));
        post({ t: 'scroll', x: at.x, y: at.y, dx: 0, dy: Math.max(-20, Math.min(20, steps)) });
      }
      return;
    }
    var p = local(event);
    var dx = p.x - gesture.start.x;
    var dy = p.y - gesture.start.y;
    if (gesture.kind === 'press' && Math.hypot(dx, dy) > 8) gesture.kind = 'pan';
    if (gesture.kind === 'pan') {
      view = clampView({ s: view.s, tx: gesture.from.tx + dx, ty: gesture.from.ty + dy }, port, size);
      moved = true;
      paint();
    }
  });
  function end(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'press' && pointers.size === 0 && event.type === 'pointerup') tap(gesture.start);
    if (pointers.size === 1 && gesture.kind !== 'press' && gesture.kind !== 'pan') {
      var rest = Array.from(pointers.values())[0];
      gesture = { kind: 'pan', start: rest, from: view };
    } else if (pointers.size === 0) gesture = null;
  }
  portElement.addEventListener('pointerup', end);
  portElement.addEventListener('pointercancel', end);
  portElement.addEventListener('wheel', function (event) {
    event.preventDefault();
    cancelAnimationFrame(tween);
    var p = local(event);
    if (mode === 'control' && !event.ctrlKey) {
      var steps = Math.trunc(event.deltaY / 50) || (event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0);
      var at = clampPoint(remotePoint(view, p));
      if (steps) post({ t: 'scroll', x: at.x, y: at.y, dx: 0, dy: Math.max(-20, Math.min(20, steps)) });
      return;
    }
    view = zoomAround(view, p, view.s * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), port, size);
    moved = true;
    paint();
  }, { passive: false });

  function tap(p) {
    var r = remotePoint(view, p);
    if (mode !== 'control') {
      var now = performance.now();
      if (now - lastTap.at < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        clearTimeout(watchTimer);
        lastTap.at = 0;
        moved = true;
        animate(view.s < 0.8 ? zoomAround(view, p, 1, port, size) : fitView(port, size), 320);
        return;
      }
      lastTap = { at: now, x: p.x, y: p.y };
      ripple(p, true);
      clearTimeout(watchTimer);
      watchTimer = setTimeout(function () { post({ t: 'watch' }); }, 300);
      return;
    }
    if (!inside(r)) return;
    ripple(p, false);
    var at = clampPoint(r);
    anchor = at;
    paint();
    post({ t: 'tap', x: at.x, y: at.y });
  }

  // The page may run before its frame has a size, and the keyboard changes it later.
  function relayout() {
    var before = port;
    measure();
    if (port.w === before.w && port.h === before.h) return;
    cancelAnimationFrame(tween);
    if (!moved) view = focused && stop ? rectView(stopRect(stop, size), port, size) : fitView(port, size);
    // The keyboard took room: keep the spot the owner last tapped in sight.
    else if (anchor && port.h < before.h - 60) view = centerOn(view, anchor, port, size);
    else view = clampView(view, port, size);
    paint();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(relayout).observe(portElement);
  window.addEventListener('resize', relayout);

  listen(function (text) {
    var c;
    try { c = JSON.parse(text); } catch (error) { return; }
    if (!c || typeof c.t !== 'string') return;
    if (c.t === 'frame') {
      decoder.decode({ id: c.id, key: !!c.key, codec: String(c.codec), data: bytes(String(c.data)) });
    } else if (c.t === 'open') {
      decoder.restart();
      if (c.w > 0 && c.h > 0 && (c.w !== size.w || c.h !== size.h)) {
        size = { w: c.w, h: c.h };
        canvas.width = c.w;
        canvas.height = c.h;
        view = moved ? clampView(view, port, size) : fitView(port, size);
        paint();
      }
    } else if (c.t === 'picture') {
      var image = new Image();
      image.onload = function () { context.drawImage(image, 0, 0, size.w, size.h); };
      image.src = String(c.uri);
    } else if (c.t === 'pointer') {
      if (mode !== 'view') return;
      stop = c.x >= 0 && c.y >= 0 ? { x: c.x, y: c.y } : null;
      // The first time the page learns where the bot stopped, it goes there, unless the owner moved the view already.
      if (stop && !focused && !moved) {
        focused = true;
        focusStop(620);
      } else paint();
    } else if (c.t === 'mode') {
      mode = c.mode === 'control' ? 'control' : 'view';
      anchor = null;
      portElement.className = mode;
      paint();
    } else if (c.t === 'labels') {
      label.textContent = String(c.stop);
    } else if (c.t === 'focus') {
      moved = true;
      focusStop(460);
    } else if (c.t === 'fit') {
      moved = true;
      animate(fitView(port, size), 460);
    }
  });

  measure();
  view = fitView(port, size);
  paint();
  post({ t: 'ready', video: typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function' });
`

const STYLE = `
html,body{margin:0;height:100%;overflow:hidden;background:var(--base);-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:none}
#port{position:fixed;inset:0;overflow:hidden;touch-action:none;background-color:var(--base);background-image:radial-gradient(rgba(255,255,255,.055) 1px,transparent 1.3px);background-size:14px 14px;cursor:grab}
#port.control{cursor:crosshair}
canvas{position:absolute;left:0;top:0;transform-origin:0 0;background:#000;box-shadow:0 0 0 1px rgba(255,255,255,.07),0 24px 60px rgba(0,0,0,.55);will-change:transform}
#reticle{position:absolute;z-index:2;pointer-events:none;opacity:0;transition:opacity .25s;border-radius:6px;background:rgba(242,189,82,.07)}
#reticle.on{opacity:1}
#reticle i{position:absolute;width:18px;height:18px;border:0 solid var(--cue);animation:breathe 1.8s ease-in-out infinite}
#reticle .tl{top:-5px;left:-5px;border-top-width:3px;border-left-width:3px;border-top-left-radius:7px;--dx:-3px;--dy:-3px}
#reticle .tr{top:-5px;right:-5px;border-top-width:3px;border-right-width:3px;border-top-right-radius:7px;--dx:3px;--dy:-3px}
#reticle .bl{bottom:-5px;left:-5px;border-bottom-width:3px;border-left-width:3px;border-bottom-left-radius:7px;--dx:-3px;--dy:3px}
#reticle .br{bottom:-5px;right:-5px;border-bottom-width:3px;border-right-width:3px;border-bottom-right-radius:7px;--dx:3px;--dy:3px}
#label{position:absolute;bottom:100%;left:-5px;margin-bottom:9px;padding:3px 7px;border-radius:5px;background:var(--cue);color:var(--on-cue);font:500 10.5px/14px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
#reticle.below #label{bottom:auto;top:100%;margin:9px 0 0}
#label:empty{display:none}
@keyframes breathe{50%{transform:translate(var(--dx),var(--dy))}}
#ripples{position:absolute;inset:0;z-index:3;pointer-events:none}
.ripple{position:absolute;width:46px;height:46px;margin:-23px 0 0 -23px;border:2px solid var(--ink);border-radius:50%;animation:ripple .55s cubic-bezier(.2,.8,.2,1) forwards}
.ripple::after{content:'';position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:var(--ink)}
.ripple.watching{border-style:dashed;border-color:var(--muted)}
.ripple.watching::after{background:var(--muted)}
@keyframes ripple{from{transform:scale(.4);opacity:1}to{transform:scale(1.15);opacity:0}}
@media (prefers-reduced-motion:reduce){*{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
`

export type ScreenPageTheme = { base: string; ink: string; muted: string; cue: string; onCue: string }

/** A theme value that cannot end its declaration or the style element. */
const SAFE_VALUE = /^#[0-9a-fA-F]{3,8}$/

/** The page, with the app's colors; the screen it shows starts as `FLEET_SCREEN` until its stream says otherwise. */
export function screenPageDocument(
  transport: ScreenPageTransport,
  theme: ScreenPageTheme,
  size: { width: number; height: number }
): string {
  const vars = (
    Object.entries({
      '--base': theme.base,
      '--ink': theme.ink,
      '--muted': theme.muted,
      '--cue': theme.cue,
      '--on-cue': theme.onCue,
    }) as [string, string][]
  )
    .filter(([, value]) => SAFE_VALUE.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SCREEN_PAGE_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
    `<style>:root{${vars}}${STYLE}</style>`,
    '</head><body><div id="port">',
    `<canvas id="screen" width="${Math.round(size.width)}" height="${Math.round(size.height)}"></canvas>`,
    '<div id="reticle"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i><span id="label"></span></div>',
    '<div id="ripples"></div></div>',
    // Code of ours only: `</script` cannot appear in it, which the tests hold it to.
    `<script>(function () {\n'use strict';${HOSTS[transport]}${SCREEN_VIEWPORT_SOURCE}${SCREEN_DECODER_SOURCE}${SCRIPT}})();</script>`,
    '</body></html>',
  ].join('')
}
