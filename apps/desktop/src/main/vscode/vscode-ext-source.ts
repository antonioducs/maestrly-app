/**
 * Plain CommonJS web extension source written into serve-web, using only require('vscode') without
 * bundling. Conversation file/selection commands write workspace .maestrly/agent-selection.json
 * through workspace.fs because web CSP blocks localhost fetches. Main watches the real file and
 * forwards references to Chat. globalStorage uses non-watchable vscode-userdata and cannot serve as
 * this bridge.
 */

export const EXT_PUBLISHER = 'claude-agents'
export const EXT_NAME = 'bridge'
export const EXT_VERSION = '0.0.16' // bump to reseed after moving sidecars into .maestrly
export const EXT_ID = `${EXT_PUBLISHER}.${EXT_NAME}`
export const EXT_DIRNAME = `${EXT_ID}-${EXT_VERSION}`
/**
 * Selection sidecar inside the real workspace .maestrly directory, Git-ignored and disk-watchable. Do
 * not use serve-web globalStorage because it is not observable on disk.
 */
export const SELECTION_REL_DIR = '.maestrly'
export const SELECTION_FILE = 'agent-selection.json'
/** App writes {rel,line,endLine,ts}; the extension opens the requested file. */
export const OPEN_FILE_FILE = 'agent-open-file.json'
/** App writes {direction,ts}; the extension navigates workbench history. */
export const NAVIGATION_FILE = 'agent-navigation.json'
export const MEMORY_SNAPSHOT_FILE = 'memory-snapshot.json'
export const MEMORY_SNAPSHOT_REQUEST_FILE = 'memory-snapshot-request.json'
export const OPEN_FILE_MAX_AGE_MS = 5 * 60_000

export interface OpenFilePayload {
  rel: string
  line?: number
  endLine?: number
  ts: number
}

/** Mirror the self-contained validation embedded in extension JavaScript. */
export function sanitizeOpenFilePayload(value: unknown, now = Date.now()): OpenFilePayload | null {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (
    typeof data.rel !== 'string' ||
    data.rel !== data.rel.trim() ||
    !Number.isSafeInteger(data.ts) ||
    (data.ts as number) > now + 5_000 ||
    now - (data.ts as number) > OPEN_FILE_MAX_AGE_MS ||
    /[\\\0\r\n]/.test(data.rel)
  )
    return null
  const segments = data.rel.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null

  const line = Number.isSafeInteger(data.line) && (data.line as number) > 0 ? (data.line as number) : undefined
  const requestedEndLine =
    Number.isSafeInteger(data.endLine) && (data.endLine as number) > 0 ? (data.endLine as number) : undefined
  const endLine = line && requestedEndLine && requestedEndLine >= line ? requestedEndLine : undefined
  return { rel: data.rel, line, endLine, ts: data.ts as number }
}

export const EXT_PACKAGE_JSON = JSON.stringify(
  {
    name: EXT_NAME,
    publisher: EXT_PUBLISHER,
    version: EXT_VERSION,
    displayName: 'Maestrly Bridge',
    description: 'Sends files and code selections to the active Maestrly conversation.',
    engines: { vscode: '^1.80.0' },
    browser: './extension.js',
    activationEvents: ['onStartupFinished'],
    contributes: {
      commands: [
        { command: 'claudeAgents.sendFile', title: 'Maestrly: Send file to conversation' },
        {
          command: 'claudeAgents.sendSelection',
          title: 'Maestrly: Send selection to conversation',
        },
      ],
      keybindings: [
        // Use Control shortcuts on Windows/Linux and Command overrides on macOS. Avoid the official Claude
        // extension's Option+Command+K conflict; send-file uses Option+Command+J / Control+Alt+J.
        { command: 'claudeAgents.sendSelection', key: 'ctrl+alt+l', mac: 'cmd+alt+l', when: 'editorTextFocus' },
        { command: 'claudeAgents.sendFile', key: 'ctrl+alt+j', mac: 'cmd+alt+j', when: 'editorTextFocus' },
      ],
      menus: {
        'explorer/context': [{ command: 'claudeAgents.sendFile', group: 'navigation@9' }],
        'editor/context': [{ command: 'claudeAgents.sendSelection', group: 'navigation@9' }],
      },
    },
  },
  null,
  2
)

// Lean web-extension-host code using only the VS Code API.
export const EXT_JS = String.raw`const vscode = require('vscode')

function activate(context) {
  const writeRef = async (uri, payload) => {
    // Write the selection sidecar in the real workspace; serve-web globalStorage is not disk-watchable.
    const ws = vscode.workspace.getWorkspaceFolder(uri) ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0])
    if (!ws) { vscode.window.showWarningMessage('No workspace to send to Maestrly.'); return }
    const dir = vscode.Uri.joinPath(ws.uri, '.maestrly')
    try { await vscode.workspace.fs.createDirectory(dir) } catch (e) {}
    const file = vscode.Uri.joinPath(dir, 'agent-selection.json')
    const body = JSON.stringify(Object.assign({}, payload, { ts: Date.now() }))
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body))
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgents.sendFile', async (uri) => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri)
      if (!target) { vscode.window.showWarningMessage('No file to send to Maestrly.'); return }
      await writeRef(target, { kind: 'file', path: target.fsPath, scheme: target.scheme })
      vscode.window.setStatusBarMessage('→ Maestrly: ' + vscode.workspace.asRelativePath(target), 2500)
    }),

    vscode.commands.registerCommand('claudeAgents.sendSelection', async () => {
      const ed = vscode.window.activeTextEditor
      if (!ed) { vscode.window.showWarningMessage('No active editor.'); return }
      const sel = ed.selection
      const startLine = sel.start.line + 1
      let endLine
      if (sel.isEmpty) endLine = sel.start.line + 1
      else if (sel.end.character === 0 && sel.end.line > sel.start.line) endLine = sel.end.line
      else endLine = sel.end.line + 1
      await writeRef(ed.document.uri, {
        kind: 'selection',
        path: ed.document.uri.fsPath,
        scheme: ed.document.uri.scheme,
        startLine: startLine,
        endLine: endLine,
        languageId: ed.document.languageId,
      })
      vscode.window.setStatusBarMessage(
        '→ Maestrly: ' + vscode.workspace.asRelativePath(ed.document.uri) + ':' + startLine + '-' + endLine,
        2500,
      )
    }),
  )

  // Debug bridge controls VS Code through DAP; see setupDebugBridge.
  setupDebugBridge(context)
  setupMemorySnapshot(context)

  // Poll agent-open-file.json requests because serve-web file watching does not reliably detect external
  // writes; open the requested relative file/line range.
  const ws0 = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (ws0) {
    let lastTs = 0
    const tick = async () => {
      try {
        const file = vscode.Uri.joinPath(ws0.uri, '.maestrly', 'agent-open-file.json')
        const buf = await vscode.workspace.fs.readFile(file)
        const data = JSON.parse(new TextDecoder().decode(buf))
        const now = Date.now()
        if (!data || typeof data.rel !== 'string' || data.rel !== data.rel.trim() ||
            !Number.isSafeInteger(data.ts) || data.ts > now + 5000 || now - data.ts > ${OPEN_FILE_MAX_AGE_MS} ||
            /[\\\0\r\n]/.test(data.rel)) return
        const segments = data.rel.split('/')
        if (segments.some((segment) => !segment || segment === '.' || segment === '..') || data.ts === lastTs) return
        const uri = vscode.Uri.joinPath(ws0.uri, ...segments)
        const owner = vscode.workspace.getWorkspaceFolder(uri)
        if (!owner || owner.uri.toString() !== ws0.uri.toString()) return
        lastTs = data.ts
        const doc = await vscode.workspace.openTextDocument(uri)
        const opts = { preview: false }
        if (Number.isSafeInteger(data.line) && data.line > 0 && doc.lineCount > 0) {
          const startIndex = Math.min(data.line, doc.lineCount) - 1
          const start = new vscode.Position(startIndex, 0)
          if (Number.isSafeInteger(data.endLine) && data.endLine >= data.line) {
            const endIndex = Math.min(data.endLine, doc.lineCount) - 1
            opts.selection = new vscode.Range(start, doc.lineAt(endIndex).range.end)
          } else {
            opts.selection = new vscode.Range(start, start)
          }
        }
        // joinPath(ws.uri, rel) uses the workspace remote provider; absolute Uri.file fails.
        await vscode.window.showTextDocument(doc, opts)
      } catch (e) {}
    }
    let lastNavigationTs = 0
    const navigationTick = async () => {
      try {
        const file = vscode.Uri.joinPath(ws0.uri, '.maestrly', 'agent-navigation.json')
        const buf = await vscode.workspace.fs.readFile(file)
        const data = JSON.parse(new TextDecoder().decode(buf))
        if (!data || data.ts === lastNavigationTs) return
        lastNavigationTs = data.ts
        if (typeof data.ts !== 'number' || Date.now() - data.ts > 5000) return
        const command = data.direction === 'back'
          ? 'workbench.action.navigateBack'
          : data.direction === 'forward'
            ? 'workbench.action.navigateForward'
            : null
        if (command) await vscode.commands.executeCommand(command)
      } catch (e) {}
    }
    const iv = setInterval(tick, 400)
    const navigationIv = setInterval(navigationTick, 150)
    context.subscriptions.push({
      dispose: () => {
        clearInterval(iv)
        clearInterval(navigationIv)
      },
    })
  }
}

// File-based debug bridge: poll debug-cmd.json, execute vscode.debug/DAP operations, and write matching
// debug-result.json. Server-side js-debug owns execution; the web extension invokes APIs and tracks
// session/thread state.
function setupDebugBridge(context) {
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (!ws) return
  const dbg = { session: null, stopped: false, threadId: null, reason: null }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Web DebugAdapterTracker does not receive server-host DAP stopped events. Poll stackTrace: frames mean
  // stopped, errors mean running. vscode.debug start/terminate events do cross hosts and identify the
  // active session.
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((s) => {
      dbg.session = s
      dbg.stopped = false
      dbg.threadId = null
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (dbg.session === s) {
        dbg.session = null
        dbg.stopped = false
        dbg.threadId = null
      }
    }),
  )

  // Probe whether the active session is stopped through stackTrace and update stopped/threadId.
  const probeStopped = async () => {
    const s = vscode.debug.activeDebugSession || dbg.session
    if (!s) {
      dbg.stopped = false
      return false
    }
    dbg.session = s
    try {
      const threads = await s.customRequest('threads')
      const tid = threads && threads.threads && threads.threads[0] && threads.threads[0].id
      if (tid != null) {
        const st = await s.customRequest('stackTrace', { threadId: tid, levels: 1 })
        if (st && st.stackFrames && st.stackFrames.length) {
          dbg.stopped = true
          dbg.threadId = tid
          return true
        }
      }
    } catch (e) {
      /* threads/stackTrace may fail while execution is running */
    }
    dbg.stopped = false
    return false
  }
  // Poll until stopped, terminated, or timed out for start/continue/step/pause/restart.
  const waitForStop = async (timeoutMs) => {
    const deadline = Date.now() + (timeoutMs || 15000)
    while (Date.now() < deadline) {
      await sleep(150)
      if (!vscode.debug.activeDebugSession && !dbg.session) return 'exited'
      if (await probeStopped()) return 'stopped'
    }
    return 'timeout'
  }
  // Use Uri.file for absolute POSIX/Windows drive/UNC paths; otherwise resolve relative to workspace.
  const isAbs = (p) => /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)
  const uriFor = (file) =>
    file && isAbs(file) ? vscode.Uri.file(file) : vscode.Uri.joinPath(ws.uri, file)
  const topLocation = async () => {
    if (!dbg.session || !dbg.stopped) return null
    try {
      const st = await dbg.session.customRequest('stackTrace', { threadId: dbg.threadId, levels: 1 })
      const f = st.stackFrames && st.stackFrames[0]
      if (!f) return null
      return { name: f.name, file: f.source && (f.source.path || f.source.name), line: f.line, frameId: f.id }
    } catch (e) {
      return null
    }
  }
  const needStopped = async () => {
    if (!vscode.debug.activeDebugSession && !dbg.session)
      throw new Error('no active debug session (use debug_start)')
    if (!(await probeStopped()))
      throw new Error('the program is running — use a breakpoint/pause before inspecting')
  }

  const ops = {
    status: async () => {
      await probeStopped()
      return {
        active: !!(vscode.debug.activeDebugSession || dbg.session),
        stopped: dbg.stopped,
        threadId: dbg.threadId,
        location: await topLocation(),
      }
    },
    start: async (a) => {
      let cfg = a.config && typeof a.config === 'object' ? a.config : null
      if (!cfg && !a.configName) {
        cfg = {
          type: 'node',
          request: 'launch',
          name: a.name || 'debug',
          internalConsoleOptions: 'neverOpen',
          cwd: ws.uri.fsPath,
        }
        if (a.program) cfg.program = isAbs(a.program) ? a.program : uriFor(a.program).fsPath
        if (a.stopOnEntry) cfg.stopOnEntry = true
        if (Array.isArray(a.args)) cfg.args = a.args
      }
      const ok = await vscode.debug.startDebugging(ws, a.configName ? a.configName : cfg)
      if (!ok) throw new Error('startDebugging failed (invalid config or no launch.json for the given name)')
      const stop = await waitForStop(a.waitMs || 12000)
      return { started: true, stop, location: await topLocation() }
    },
    stop: async () => {
      await vscode.debug.stopDebugging(dbg.session || undefined)
      dbg.session = null
      dbg.stopped = false
      return { stopped: true }
    },
    restart: async () => {
      if (!dbg.session) throw new Error('no active session')
      try {
        await dbg.session.customRequest('restart')
      } catch (e) {
        await vscode.debug.stopDebugging(dbg.session)
      }
      const stop = await waitForStop(12000)
      return { restarted: true, stop, location: await topLocation() }
    },
    pause: async () => {
      if (!dbg.session) throw new Error('no active session')
      await dbg.session.customRequest('pause', { threadId: dbg.threadId || 1 })
      const stop = await waitForStop(5000)
      return { stop, location: await topLocation() }
    },
    continue: async () => {
      await needStopped()
      dbg.stopped = false
      await dbg.session.customRequest('continue', { threadId: dbg.threadId })
      await sleep(200) // let continue propagate before probing to avoid reading the previous frame
      const stop = await waitForStop(15000)
      return { stop, location: await topLocation() }
    },
    step: async (a) => {
      await needStopped()
      const g = (a && a.granularity) || 'over'
      const req = g === 'into' ? 'stepIn' : g === 'out' ? 'stepOut' : 'next'
      dbg.stopped = false
      await dbg.session.customRequest(req, { threadId: dbg.threadId })
      await sleep(150)
      const stop = await waitForStop(10000)
      return { stop, location: await topLocation() }
    },
    bp_add: async (a) => {
      if (!a || !a.file || a.line == null) throw new Error('file and line are required')
      const loc = new vscode.Location(uriFor(a.file), new vscode.Position(a.line - 1, 0))
      const bp = new vscode.SourceBreakpoint(loc, a.enabled !== false, a.condition || undefined)
      vscode.debug.addBreakpoints([bp])
      return { added: { file: a.file, line: a.line, condition: a.condition || null } }
    },
    bp_remove: async (a) => {
      const target = uriFor(a.file).fsPath
      const rm = vscode.debug.breakpoints.filter(
        (b) => b.location && b.location.uri.fsPath === target && b.location.range.start.line + 1 === a.line,
      )
      vscode.debug.removeBreakpoints(rm)
      return { removed: rm.length }
    },
    bp_clear: async () => {
      const all = vscode.debug.breakpoints
      vscode.debug.removeBreakpoints(all)
      return { removed: all.length }
    },
    bp_list: async () => ({
      breakpoints: vscode.debug.breakpoints
        .filter((b) => b.location)
        .map((b) => ({
          file: vscode.workspace.asRelativePath(b.location.uri),
          line: b.location.range.start.line + 1,
          enabled: b.enabled,
          condition: b.condition || null,
        })),
    }),
    stack: async () => {
      await needStopped()
      const st = await dbg.session.customRequest('stackTrace', { threadId: dbg.threadId, levels: 20 })
      return {
        frames: (st.stackFrames || []).map((f) => ({
          id: f.id,
          name: f.name,
          file: f.source && (f.source.path || f.source.name),
          line: f.line,
        })),
      }
    },
    inspect: async (a) => {
      await needStopped()
      let frameId = a && a.frameId
      if (frameId == null) {
        const st = await dbg.session.customRequest('stackTrace', { threadId: dbg.threadId, levels: 1 })
        frameId = st.stackFrames[0].id
      }
      const scopes = await dbg.session.customRequest('scopes', { frameId })
      const out = []
      const all = (scopes && scopes.scopes) || []
      for (let i = 0; i < all.length; i++) {
        const sc = all[i]
        if (sc.expensive) {
          out.push({ scope: sc.name, note: 'expensive (omitido)' })
          continue
        }
        const vars = await dbg.session.customRequest('variables', { variablesReference: sc.variablesReference })
        out.push({
          scope: sc.name,
          variables: ((vars && vars.variables) || []).map((v) => ({
            name: v.name,
            value: v.value,
            type: v.type,
            ref: v.variablesReference || 0,
          })),
        })
      }
      return { frameId, scopes: out }
    },
    variables: async (a) => {
      if (!dbg.session) throw new Error('no active session')
      if (!a || a.ref == null) throw new Error('ref (variablesReference) required — see debug_inspect')
      const vars = await dbg.session.customRequest('variables', { variablesReference: a.ref })
      return {
        variables: ((vars && vars.variables) || []).map((v) => ({
          name: v.name,
          value: v.value,
          type: v.type,
          ref: v.variablesReference || 0,
        })),
      }
    },
    evaluate: async (a) => {
      if (!dbg.session) throw new Error('no active session')
      if (!a || !a.expression) throw new Error('expression is required')
      let frameId = a.frameId
      if (frameId == null && dbg.stopped) {
        const st = await dbg.session.customRequest('stackTrace', { threadId: dbg.threadId, levels: 1 })
        frameId = st.stackFrames[0].id
      }
      const r = await dbg.session.customRequest('evaluate', {
        expression: a.expression,
        frameId,
        context: 'repl',
      })
      return { result: r.result, type: r.type, ref: r.variablesReference || 0 }
    },
  }

  let lastId = ''
  const tick = async () => {
    let cmd
    try {
      const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ws.uri, '.maestrly', 'debug-cmd.json'))
      cmd = JSON.parse(new TextDecoder().decode(buf))
    } catch (e) {
      return // no command yet
    }
    if (!cmd || !cmd.id || cmd.id === lastId) return
    lastId = cmd.id
    const res = { id: cmd.id, ok: false, data: null, error: null }
    try {
      const fn = ops[cmd.op]
      if (!fn) throw new Error('op de debug desconhecida: ' + cmd.op)
      res.data = await fn(cmd.args || {})
      res.ok = true
    } catch (e) {
      res.error = String((e && e.message) || e)
    }
    try {
      const out = vscode.Uri.joinPath(ws.uri, '.maestrly', 'debug-result.json')
      await vscode.workspace.fs.writeFile(out, new TextEncoder().encode(JSON.stringify(res)))
    } catch (e) {}
  }
  const iv = setInterval(tick, 150)
  context.subscriptions.push({ dispose: () => clearInterval(iv) })
}

function setupMemorySnapshot(context) {
  const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (!ws) return
  let lastActivityAt = Date.now()
  let lastRequestId = ''
  const touch = () => { lastActivityAt = Date.now() }
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(touch),
    vscode.window.onDidChangeActiveTextEditor(touch),
    vscode.debug.onDidStartDebugSession(touch),
    vscode.debug.onDidTerminateDebugSession(touch),
  )
  const writeSnapshot = async (requestId) => {
    const dirtyDocuments = vscode.workspace.textDocuments.filter((doc) => doc.isDirty).length
    const snapshot = {
      requestId: requestId || '',
      dirtyDocuments,
      debugActive: !!(vscode.debug.activeDebugSession),
      operationInFlight: false,
      lastActivityAt,
      ts: Date.now(),
    }
    try {
      const dir = vscode.Uri.joinPath(ws.uri, '.maestrly')
      try { await vscode.workspace.fs.createDirectory(dir) } catch (e) {}
      const file = vscode.Uri.joinPath(dir, 'memory-snapshot.json')
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(snapshot)))
    } catch (e) {}
  }
  const tick = async () => {
    try {
      const file = vscode.Uri.joinPath(ws.uri, '.maestrly', 'memory-snapshot-request.json')
      const buf = await vscode.workspace.fs.readFile(file)
      const data = JSON.parse(new TextDecoder().decode(buf))
      if (!data || typeof data.id !== 'string' || data.id === lastRequestId) return
      lastRequestId = data.id
      await writeSnapshot(data.id)
    } catch (e) {}
  }
  const iv = setInterval(tick, 200)
  context.subscriptions.push({ dispose: () => clearInterval(iv) })
  void writeSnapshot('')
}

function deactivate() {}
module.exports = { activate, deactivate }
`
