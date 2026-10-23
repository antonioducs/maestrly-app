/**
 * Progress of preparing this computer's editor: the standalone CLI download on first use, then the download,
 * extraction and start of the VS Code server that serve-web reports on its stdout. Both downloads add up to one
 * percentage that only grows until the editor is ready, so the loading page neither stalls silently nor goes back.
 */

/** What preparing the editor is doing now; idle once the editor is ready or when nothing is being set up. */
export type VSCodeSetupStage = 'idle' | 'download' | 'installing' | 'starting'

export interface VSCodeSetupProgress {
  stage: VSCodeSetupStage
  /** Share of the whole setup done, 0–100, or null before anything is measured. */
  percent: number | null
  /** Bytes of the current download received so far, and its size when known. */
  received: number
  total: number | null
  /** Whether this setup downloads anything: starting an installed server has no progress to show. */
  downloaded: boolean
}

export type VSCodeSetupEvent =
  | { kind: 'cli-download'; received: number; total: number | null }
  | { kind: 'server-download'; received: number; total: number | null; commit?: string }
  | { kind: 'server-starting'; commit?: string }
  | { kind: 'server-ready'; commit?: string }
  | { kind: 'reset' }

/** Share of the bar the CLI takes when it downloads too: about 10 MB against the server's 230 MB. */
export const CLI_SHARE = 5

export interface VSCodeSetupState extends VSCodeSetupProgress {
  cliShare: number
  /** The server version being set up, full or as serve-web's 7-character prefix. */
  commit: string | null
}

export const IDLE_SETUP: VSCodeSetupState = {
  stage: 'idle',
  percent: null,
  received: 0,
  total: null,
  downloaded: false,
  cliShare: 0,
  commit: null,
}

function fraction(received: number, total: number | null): number {
  if (!total || total <= 0) return 0
  return Math.min(1, Math.max(0, received / total))
}

/** serve-web logs full commits and 7-character prefixes; another version's lines do not move this setup. */
function otherServer(state: VSCodeSetupState, commit: string | undefined): boolean {
  if (state.stage === 'idle' || !state.commit || !commit) return false
  return !state.commit.startsWith(commit) && !commit.startsWith(state.commit)
}

export function reduceVSCodeSetup(prev: VSCodeSetupState, event: VSCodeSetupEvent): VSCodeSetupState {
  switch (event.kind) {
    case 'reset':
      return IDLE_SETUP
    case 'cli-download':
      return {
        ...prev,
        stage: 'download',
        cliShare: CLI_SHARE,
        percent: Math.max(prev.percent ?? 0, CLI_SHARE * fraction(event.received, event.total)),
        received: event.received,
        total: event.total,
        downloaded: true,
      }
    case 'server-download': {
      if (otherServer(prev, event.commit)) return prev
      const done = !!event.total && event.received >= event.total
      return {
        ...prev,
        stage: done ? 'installing' : 'download',
        percent: Math.max(
          prev.percent ?? 0,
          prev.cliShare + (100 - prev.cliShare) * fraction(event.received, event.total)
        ),
        received: event.received,
        total: event.total,
        downloaded: true,
        commit: event.commit ?? prev.commit,
      }
    }
    case 'server-starting':
      if (otherServer(prev, event.commit)) return prev
      return { ...prev, stage: 'starting', commit: event.commit ?? prev.commit }
    case 'server-ready':
      return otherServer(prev, event.commit) ? prev : IDLE_SETUP
  }
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const TRACE = /^\[[^\]]*\]\s+trace\s/
const PROGRESS = /\bDownloading server:\s*(\d+)\/(\d+)/
const DOWNLOAD_START = /\bDownloading server ([0-9a-f]{40})\b/
const STARTING = /\bStarting server ([0-9a-f]{40})\b/
const BOUND = /(?:\[([0-9a-f]{7,40}) stdout\]:\s*)?Server bound to\b/

export interface ServeWebLine {
  /** The line without color codes, as it should be logged. */
  text: string
  /** Trace lines (download progress, websocket upgrades) are too many to log. */
  trace: boolean
  event: VSCodeSetupEvent | null
}

/** Read one stdout line of `code serve-web --log trace` (cli/src/commands/serve_web.rs). */
export function parseServeWebLine(raw: string): ServeWebLine {
  const text = raw.replace(ANSI, '').trimEnd()
  const trace = TRACE.test(text)
  let match = PROGRESS.exec(text)
  if (match) {
    const total = Number(match[2])
    return {
      text,
      trace,
      event: { kind: 'server-download', received: Number(match[1]), total: total > 0 ? total : null },
    }
  }
  match = DOWNLOAD_START.exec(text)
  if (match) return { text, trace, event: { kind: 'server-download', received: 0, total: null, commit: match[1] } }
  match = STARTING.exec(text)
  if (match) return { text, trace, event: { kind: 'server-starting', commit: match[1] } }
  match = BOUND.exec(text)
  if (match) return { text, trace, event: { kind: 'server-ready', ...(match[1] ? { commit: match[1] } : {}) } }
  return { text, trace, event: null }
}

/** Split a process stream into lines; a chunk can end in the middle of one. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let rest = ''
  return (chunk) => {
    const lines = (rest + String(chunk)).split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) onLine(line)
  }
}

let state: VSCodeSetupState = IDLE_SETUP
const listeners = new Set<(progress: VSCodeSetupProgress) => void>()

function snapshot(s: VSCodeSetupState): VSCodeSetupProgress {
  return { stage: s.stage, percent: s.percent, received: s.received, total: s.total, downloaded: s.downloaded }
}

/** What the loading page shows changes at whole percents and every 0.1 MB, not at every chunk. */
function visibleKey(s: VSCodeSetupState): string {
  const percent = s.percent === null ? '' : Math.floor(s.percent)
  return `${s.stage}|${percent}|${Math.floor(s.received / 100_000)}|${s.total ?? ''}|${s.downloaded}`
}

export function noteVSCodeSetup(event: VSCodeSetupEvent): void {
  const next = reduceVSCodeSetup(state, event)
  if (next === state) return
  const changed = visibleKey(next) !== visibleKey(state)
  state = next
  if (!changed) return
  const progress = snapshot(state)
  for (const listener of listeners) listener(progress)
}

export function getVSCodeSetupProgress(): VSCodeSetupProgress {
  return snapshot(state)
}

export function onVSCodeSetupProgress(listener: (progress: VSCodeSetupProgress) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What the loading page draws: a bar (indeterminate without a percent) and the line under it. */
export interface VSCodeSetupView {
  visible: boolean
  percent: number | null
  label: string
}

export function vscodeSetupView(
  progress: VSCodeSetupProgress,
  t: (key: string, vars?: Record<string, unknown>) => string,
  locale: string
): VSCodeSetupView {
  if (progress.stage === 'idle' || !progress.downloaded) return { visible: false, percent: null, label: '' }
  if (progress.stage === 'installing' || progress.stage === 'starting') {
    const key = progress.stage === 'installing' ? 'progressInstalling' : 'progressStarting'
    return { visible: true, percent: null, label: t(`drawerLoading.${key}`) }
  }
  const percent = progress.percent === null ? null : Math.floor(progress.percent)
  if (!progress.total || percent === null) {
    return { visible: true, percent, label: t('drawerLoading.progressDownloading') }
  }
  const totalMb = progress.total / 1_000_000
  const mb = new Intl.NumberFormat(locale, { maximumFractionDigits: totalMb < 10 ? 1 : 0 })
  return {
    visible: true,
    percent,
    label: t('drawerLoading.progressDownload', {
      percent,
      received: mb.format(progress.received / 1_000_000),
      total: mb.format(totalMb),
    }),
  }
}
