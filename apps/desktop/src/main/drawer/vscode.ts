import { WebContentsView } from 'electron'
import { tMain, getMainLocale } from '../i18n'
import { attachHotkeyCapture } from '../hotkeys'
import { attachMacMouseNavigation } from '../mouse-navigation'
import { requestVSCodeNavigation } from '../vscode/vscode-navigation'
import {
  OFFSCREEN,
  activeConvId,
  convHasPopup,
  drawers,
  getDrawer,
  getPlacement,
  isTabFloating,
  visibleKind,
  win,
  type ConvDrawer,
} from './state'
import { applyLayout } from './layout'
import {
  registerThrottleTarget,
  resourceNeedsFullSpeed,
  unregisterThrottleTarget,
} from '../performance/resource-governor'
import { registerPerformanceWebContents, unregisterPerformanceWebContents } from '../performance/metrics'
import { registerReclaimable, scheduleMemoryReclaim, unregisterReclaimable } from '../performance/memory-reclaimer'
import { VSCODE_SERVER_IDLE_TTL_MS, VSCODE_VIEW_COLD_TTL_MS } from '../performance/policy'
import { getConversation } from '../store'
import { hasVSCodeBridgeInFlight, onVSCodeBridgeIdle, requestVSCodeMemorySnapshot } from '../vscode/vscode-memory'
import { isVSCodeServerRunning, stopVSCodeServer } from '../vscode/vscode-server'

// VS Code theme settings are global across conversations.
let vscodeSettingsJson = ''

// Per-conversation VS Code views.

const VSCODE_PARTITION = 'persist:vscode-drawer' // share settings/extensions while folder isolates workspaces
const lastUsedAt = new Map<string, number>()
const vscodeSurfaceShownByConv = new Map<string, boolean>()
const viewGeneration = new Map<string, number>()
const SERVER_IDLE_KEY = 'vscode-server'

function vscodeReclaimKey(convId: string): string {
  return `vscode:${convId}`
}

function vscodeSurfaceIsShown(convId: string): boolean {
  return (
    (activeConvId === convId && visibleKind === 'vscode' && getPlacement(convId, 'vscode') === 'slot') ||
    isTabFloating(convId, 'vscode') ||
    getPlacement(convId, 'vscode') === 'popup' ||
    convHasPopup(convId)
  )
}

/** Restart warm TTL when the surface becomes hidden, matching browser/ChatGPT behavior. */
export function noteVSCodeSurfaceVisibility(convId: string): void {
  const shown = vscodeSurfaceIsShown(convId)
  const wasShown = vscodeSurfaceShownByConv.get(convId) ?? false
  vscodeSurfaceShownByConv.set(convId, shown)
  if (!wasShown || shown) return
  lastUsedAt.set(convId, Date.now())
  scheduleMemoryReclaim()
}

function materializedVSCodeCount(): number {
  return [...drawers.values()].filter((drawer) => drawer.vscodeView && !drawer.vscodeView.webContents.isDestroyed())
    .length
}

export function closeVSCodeView(convId: string): void {
  unregisterReclaimable(vscodeReclaimKey(convId))
  const d = drawers.get(convId)
  const view = d?.vscodeView
  if (d) {
    d.vscodeView = null
    d.vscodePendingUrl = null
  }
  if (!view) {
    unregisterThrottleTarget('vscode', convId)
    scheduleVSCodeServerIdle()
    return
  }
  unregisterThrottleTarget('vscode', convId)
  unregisterPerformanceWebContents(view.webContents)
  try {
    win?.contentView.removeChildView(view)
  } catch {
    /* already detached */
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close()
  } catch {
    /* already closed */
  }
  scheduleVSCodeServerIdle()
}

function registerVSCodeReclaimable(convId: string, generation: number): void {
  registerReclaimable({
    key: vscodeReclaimKey(convId),
    kind: 'vscode',
    lastActiveAt: () => lastUsedAt.get(convId) ?? Date.now(),
    coldTtlMs: VSCODE_VIEW_COLD_TTL_MS,
    priority: 40,
    protection: async () => {
      const reasons: string[] = []
      if (viewGeneration.get(convId) !== generation) reasons.push('stale-owner')
      if (vscodeSurfaceIsShown(convId)) reasons.push('visible')
      if (resourceNeedsFullSpeed('vscode', convId)) reasons.push('full-speed')
      const cwd = getConversation(convId)?.cwd
      if (cwd && hasVSCodeBridgeInFlight(cwd)) reasons.push('bridge-in-flight')
      // Cheap eviction blockers avoid waking the extension or polling sidecars. Request snapshots only for
      // hidden eligible views with known ownership/cwd.
      if (reasons.length > 0) return { protected: true, reasons }
      if (!cwd) return { protected: true, reasons: ['unknown'] }

      const snapshot = await requestVSCodeMemorySnapshot(cwd)
      if (!snapshot) return { protected: true, reasons: ['unknown'] }
      if (snapshot.dirtyDocuments > 0) reasons.push('dirty')
      if (snapshot.debugActive) reasons.push('debug')
      if (snapshot.operationInFlight) reasons.push('bridge-in-flight')
      if (snapshot.lastActivityAt) {
        lastUsedAt.set(convId, Math.max(lastUsedAt.get(convId) ?? 0, snapshot.lastActivityAt))
      }
      return { protected: reasons.length > 0, reasons }
    },
    prepare: async () => {
      if (viewGeneration.get(convId) !== generation) return { ok: false, reason: 'stale-owner' }
      return { ok: true }
    },
    evict: () => {
      if (viewGeneration.get(convId) !== generation) return
      closeVSCodeView(convId)
    },
  })
}

function scheduleVSCodeServerIdle(): void {
  if (materializedVSCodeCount() > 0 || hasVSCodeBridgeInFlight()) {
    unregisterReclaimable(SERVER_IDLE_KEY)
    return
  }
  if (!isVSCodeServerRunning()) {
    unregisterReclaimable(SERVER_IDLE_KEY)
    return
  }
  const idleSince = Date.now()
  registerReclaimable({
    key: SERVER_IDLE_KEY,
    kind: 'worker',
    lastActiveAt: () => idleSince,
    coldTtlMs: VSCODE_SERVER_IDLE_TTL_MS,
    priority: 80,
    protection: () => {
      if (materializedVSCodeCount() > 0) return { protected: true, reasons: ['views'] }
      if (hasVSCodeBridgeInFlight()) return { protected: true, reasons: ['bridge-in-flight'] }
      return { protected: false, reasons: [] }
    },
    prepare: async () => ({ ok: materializedVSCodeCount() === 0 && !hasVSCodeBridgeInFlight() }),
    evict: () => {
      if (materializedVSCodeCount() > 0 || hasVSCodeBridgeInFlight()) return
      stopVSCodeServer()
      unregisterReclaimable(SERVER_IDLE_KEY)
    },
  })
  scheduleMemoryReclaim()
}

onVSCodeBridgeIdle(scheduleVSCodeServerIdle)

// Seed user VS Code settings once only if absent/empty. Thereafter persistent browser storage retains
// in-editor changes. Return seeded for one applying reload, exists without changes, or error for retry on a
// later load.
function buildInjectScript(settingsJson: string): string {
  return `(async()=>{
    try{
      const DESIRED=${JSON.stringify(settingsJson)};
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('vscode-web-db');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      if(![...db.objectStoreNames].includes('vscode-userdata-store')){db.close();return 'error:no-store'}
      const KEY='/User/settings.json';
      const cur=await new Promise((res)=>{const tx=db.transaction('vscode-userdata-store','readonly');const rq=tx.objectStore('vscode-userdata-store').get(KEY);rq.onsuccess=()=>res(rq.result);rq.onerror=()=>res(undefined)});
      const curStr=(typeof cur==='string'?cur:(cur==null?'':String(cur))).trim();
      if(curStr&&curStr!=='{}'){db.close();return 'exists'}
      await new Promise((res,rej)=>{const tx=db.transaction('vscode-userdata-store','readwrite');tx.objectStore('vscode-userdata-store').put(DESIRED,KEY);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)});
      db.close();return 'seeded';
    }catch(e){return 'error:'+(e&&e.message||e)}
  })()`
}

function attachThemeInjector(view: WebContentsView): void {
  const wc = view.webContents
  let reloadsLeft = 2
  wc.on('did-finish-load', () => {
    if (!vscodeSettingsJson) return
    setTimeout(async () => {
      try {
        const res = await wc.executeJavaScript(buildInjectScript(vscodeSettingsJson))
        // Reload only after newly seeding settings. Existing settings remain untouched; a not-yet-mounted
        // store retries on a later did-finish-load within reloadsLeft.
        if (res === 'seeded' && reloadsLeft > 0) {
          reloadsLeft--
          wc.reload()
        }
      } catch {
        /* best-effort */
      }
    }, 1200)
  })
}

/** Idempotently create an offscreen conversation VS Code view with theme injection. */
export function ensureVSCodeView(d: ConvDrawer, convId: string): WebContentsView {
  if (!d.vscodeView || d.vscodeView.webContents.isDestroyed()) {
    if (d.vscodeView) {
      unregisterReclaimable(vscodeReclaimKey(convId))
      unregisterThrottleTarget('vscode', convId)
      unregisterPerformanceWebContents(d.vscodeView.webContents)
    }
    d.vscodeView = null
    d.vscodeRequestedUrl = '' // newly materialized views must always load their requested URL
    d.vscodeView = new WebContentsView({ webPreferences: { partition: VSCODE_PARTITION } })
    d.vscodeView.setBackgroundColor('#0A0A0B') // match slot/loading background to avoid a white flash
    d.vscodeView.setBounds(OFFSCREEN)
    win!.contentView.addChildView(d.vscodeView)
    attachThemeInjector(d.vscodeView)
    attachHotkeyCapture(d.vscodeView.webContents) // #328: capture shortcuts while web editor content has focus
    attachMacMouseNavigation(d.vscodeView.webContents, (direction) => {
      void requestVSCodeNavigation(convId, direction)
    })
    const wc = d.vscodeView.webContents
    const generation = (viewGeneration.get(convId) ?? 0) + 1
    viewGeneration.set(convId, generation)
    lastUsedAt.set(convId, Date.now())
    registerThrottleTarget('vscode', convId, undefined, wc)
    registerPerformanceWebContents(wc, { kind: 'vscode', convId })
    registerVSCodeReclaimable(convId, generation)
    unregisterReclaimable(SERVER_IDLE_KEY)
    wc.once('destroyed', () => {
      unregisterPerformanceWebContents(wc)
      if (viewGeneration.get(convId) === generation) {
        unregisterReclaimable(vscodeReclaimKey(convId))
        const current = drawers.get(convId)
        if (current?.vscodeView?.webContents === wc) current.vscodeView = null
        scheduleVSCodeServerIdle()
      }
    })
  }
  lastUsedAt.set(convId, Date.now())
  scheduleMemoryReclaim()
  return d.vscodeView
}

/** Navigate the workbench only when this conversation's VS Code has focus. */
export function navigateFocusedVSCode(convId: string, direction: 'back' | 'forward'): boolean {
  const view = drawers.get(convId)?.vscodeView
  if (!view?.webContents.isFocused()) return false
  void requestVSCodeNavigation(convId, direction)
  return true
}

// #318: Render a themed loading page inside the native view while serve-web downloads/starts; React
// overlays cannot cover it. Replace it with the real editor URL when readiness checks complete.
type VSCodeLoadPhase = 'downloading' | 'starting' | 'restarting' | 'error'

function vscodeLoadingHtml(phase: VSCodeLoadPhase): string {
  const t = tMain('main')
  const copy: Record<VSCodeLoadPhase, { title: string; sub: string }> = {
    downloading: {
      title: t('drawerLoading.downloadingTitle'),
      sub: t('drawerLoading.downloadingSub'),
    },
    starting: {
      title: t('drawerLoading.startingTitle'),
      sub: t('drawerLoading.startingSub'),
    },
    restarting: {
      title: t('drawerLoading.restartingTitle'),
      sub: t('drawerLoading.restartingSub'),
    },
    error: {
      title: t('drawerLoading.errorTitle'),
      sub: t('drawerLoading.errorSub'),
    },
  }
  const { title, sub } = copy[phase]
  // Errors are final states without a spinner; reopening Code retries.
  const indicator = phase === 'error' ? `<div class="warn">!</div>` : `<div class="ring"></div>`
  // Self-contained offline HTML using slot background, platinum accent, and app font.
  return `<!doctype html><html lang="${getMainLocale()}"><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{display:flex;align-items:center;justify-content:center;background:#0A0A0B;
    font-family:'SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    color:rgba(237,239,245,.96);-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
  .box{display:flex;flex-direction:column;align-items:center;text-align:center;gap:18px;
    max-width:420px;padding:32px}
  .ring{width:34px;height:34px;border-radius:50%;border:2.5px solid rgba(255,255,255,.10);
    border-top-color:#EDEAE3;animation:spin .8s linear infinite}
  .warn{width:34px;height:34px;border-radius:50%;border:2.5px solid rgba(255,255,255,.14);
    display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#EDEAE3}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.ring{animation-duration:1.6s}}
  h1{font-size:15px;font-weight:600;letter-spacing:.2px}
  p{font-size:13px;line-height:1.5;color:rgba(178,182,196,.72)}
</style></head>
<body><div class="box">
  ${indicator}
  <h1>${title}</h1>
  <p>${sub}</p>
</div></body></html>`
}

function vscodeLoadingDataUrl(phase: VSCodeLoadPhase): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(vscodeLoadingHtml(phase))}`
}

/**
 * Show the loading page and mark targetUrl pending to deduplicate waits. Leave vscodeRequestedUrl
 * untouched so the later real URL load still runs.
 */
export function showVSCodeLoading(convId: string, targetUrl: string, phase: VSCodeLoadPhase = 'starting'): void {
  const d = getDrawer(convId)
  const v = ensureVSCodeView(d, convId)
  d.vscodePendingUrl = targetUrl
  v.webContents.loadURL(vscodeLoadingDataUrl(phase))
  applyLayout()
}

/** Apply the loading page to every open editor view during a global server restart. */
export function showVSCodeLoadingAll(phase: VSCodeLoadPhase = 'restarting'): void {
  const u = vscodeLoadingDataUrl(phase)
  for (const d of drawers.values()) {
    if (!d.vscodeView) continue
    d.vscodeView.webContents.loadURL(u)
  }
}

/**
 * Show a spinner-free error after CLI download/server startup failure. Clear guards so reopening Code
 * retries.
 */
export function showVSCodeError(convId: string): void {
  const d = getDrawer(convId)
  const v = ensureVSCodeView(d, convId)
  d.vscodePendingUrl = null
  d.vscodeRequestedUrl = '' // clear loaded URL so the next editor request retries
  v.webContents.loadURL(vscodeLoadingDataUrl('error'))
  applyLayout()
}

/**
 * Require a live materialized view already requested at exactly this URL. A stale requested URL after
 * eviction/disposal must not skip loading a newly created view.
 */
export function isVSCodeShowing(convId: string, url: string): boolean {
  const d = drawers.get(convId)
  const view = d?.vscodeView
  if (!view || view.webContents.isDestroyed()) return false
  return d.vscodeRequestedUrl === url
}

/** Whether a wait/navigation to this URL is already in progress. */
export function isVSCodePending(convId: string, url: string): boolean {
  return drawers.get(convId)?.vscodePendingUrl === url
}

export function loadVSCode(convId: string, url: string, settingsJson?: string): void {
  if (settingsJson) vscodeSettingsJson = settingsJson
  const d = getDrawer(convId)
  const v = ensureVSCodeView(d, convId)
  d.vscodePendingUrl = null // navigation completed or was unnecessary; release the guard
  // Compare requested URL because VS Code rewrites its URL while loading.
  if (url !== d.vscodeRequestedUrl) {
    d.vscodeRequestedUrl = url
    v.webContents.loadURL(url)
  }
  applyLayout()
}

/**
 * After global serve-web restart, reload every open editor using its existing folder parameter and the
 * new server URL/port. Force reload even if the port is unchanged because content belonged to the
 * terminated server.
 */
export function reloadAllVSCode(buildUrl: (folder: string) => string, settingsJson?: string): void {
  if (settingsJson) vscodeSettingsJson = settingsJson
  for (const d of drawers.values()) {
    if (!d.vscodeView) continue
    let folder = ''
    try {
      folder = new URL(d.vscodeRequestedUrl).searchParams.get('folder') ?? ''
    } catch {
      /* An unloaded view has no folder URL yet; reload without a folder. */
    }
    const url = buildUrl(folder)
    d.vscodeRequestedUrl = url
    d.vscodePendingUrl = null
    d.vscodeView.webContents.loadURL(url)
  }
}
