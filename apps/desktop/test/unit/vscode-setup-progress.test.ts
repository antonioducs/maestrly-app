import { describe, expect, it, vi } from 'vitest'
import {
  CLI_SHARE,
  IDLE_SETUP,
  getVSCodeSetupProgress,
  lineSplitter,
  noteVSCodeSetup,
  onVSCodeSetupProgress,
  parseServeWebLine,
  reduceVSCodeSetup,
  vscodeSetupView,
  type VSCodeSetupEvent,
  type VSCodeSetupState,
} from '../../src/main/vscode/setup-progress'

const COMMIT = 'e646868227c3e3a9e3f24277c8c7220be42c0be7'
const OTHER = '2d0b7506a36c1d6db9a466440131a8e01eab2289'

/** Lines as `code serve-web --log trace` (VS Code CLI 1.143) prints them while it downloads and starts a server. */
const LOG = [
  '[2026-10-23 01:44:34] debug refreshed latest release: 1.143.1 (commit e646868227c3e3a9e3f24277c8c7220be42c0be7)',
  `[2026-10-23 01:44:36] info Downloading server ${COMMIT}`,
  '[2026-10-23 01:44:38] trace Downloading server: 0/229217515 (0%)',
  '[2026-10-23 01:44:38] trace Downloading server: 2105344/229217515 (1%)',
  '[2026-10-23 01:45:03] trace Downloading server: 115619980/229217515 (50%)',
  '[2026-10-23 01:45:34] trace Downloading server: 229217515/229217515 (100%)',
  `[2026-10-23 01:45:39] info Starting server ${COMMIT}`,
  '[2026-10-23 01:45:39] info [e646868 stdout]: Server bound to /tmp/code-017954e1-2d7e-41fd-a185-a78c85eab49a',
]

function replay(events: VSCodeSetupEvent[], from: VSCodeSetupState = IDLE_SETUP): VSCodeSetupState[] {
  const states: VSCodeSetupState[] = []
  let state = from
  for (const event of events) {
    state = reduceVSCodeSetup(state, event)
    states.push(state)
  }
  return states
}

const events = (lines: string[]): VSCodeSetupEvent[] => lines.flatMap((line) => parseServeWebLine(line).event ?? [])

const t = (key: string, vars?: Record<string, unknown>): string => (vars ? `${key} ${JSON.stringify(vars)}` : key)

describe('reading serve-web output', () => {
  it('turns the download, its end, the start and the bound server into setup events', () => {
    expect(events(LOG)).toEqual([
      { kind: 'server-download', received: 0, total: null, commit: COMMIT },
      { kind: 'server-download', received: 0, total: 229217515 },
      { kind: 'server-download', received: 2105344, total: 229217515 },
      { kind: 'server-download', received: 115619980, total: 229217515 },
      { kind: 'server-download', received: 229217515, total: 229217515 },
      { kind: 'server-starting', commit: COMMIT },
      { kind: 'server-ready', commit: 'e646868' },
    ])
  })

  it('marks trace lines, strips color codes and ignores the rest', () => {
    const colored = '\x1b[2m[2026-10-23 01:44:38]\x1b[0m trace Downloading server: 10/20 (50%)'
    expect(parseServeWebLine(`\x1b[2m${colored}\x1b[0m`)).toEqual({
      text: '[2026-10-23 01:44:38] trace Downloading server: 10/20 (50%)',
      trace: true,
      event: { kind: 'server-download', received: 10, total: 20 },
    })
    expect(parseServeWebLine('[2026-10-23 01:44:40] trace websocket upgrade succeeded')).toEqual({
      text: '[2026-10-23 01:44:40] trace websocket upgrade succeeded',
      trace: true,
      event: null,
    })
    expect(parseServeWebLine(LOG[0])).toMatchObject({ trace: false, event: null })
    expect(parseServeWebLine('Web UI available at http://127.0.0.1:8930?tkn=x')).toMatchObject({ event: null })
  })

  it('splits chunks into whole lines, even when a line spans two chunks', () => {
    const lines: string[] = []
    const write = lineSplitter((line) => lines.push(line))
    write('[a] info one\r\n[b] trace Down')
    write(Buffer.from('loading server: 1/2 (50%)\n\n[c] info th'))
    expect(lines).toEqual(['[a] info one', '[b] trace Downloading server: 1/2 (50%)'])
    write('ree\n')
    expect(lines.at(-1)).toBe('[c] info three')
  })
})

describe('setup progress', () => {
  it('follows the server download to the end, then installs, starts and resets once it is bound', () => {
    const states = replay(events(LOG))
    expect(states.map((s) => s.stage)).toEqual([
      'download',
      'download',
      'download',
      'download',
      'installing',
      'starting',
      'idle',
    ])
    expect(states.map((s) => (s.percent === null ? null : Math.floor(s.percent)))).toEqual([
      0,
      0,
      0,
      50,
      100,
      100,
      null,
    ])
    expect(states[3]).toMatchObject({ received: 115619980, total: 229217515, downloaded: true, commit: COMMIT })
    expect(states.at(-1)).toEqual(IDLE_SETUP)
  })

  it('gives the CLI the first share of the bar on a first setup and never goes back', () => {
    const states = replay([
      { kind: 'cli-download', received: 0, total: 10_000_000 },
      { kind: 'cli-download', received: 5_000_000, total: 10_000_000 },
      { kind: 'cli-download', received: 10_000_000, total: 10_000_000 },
      { kind: 'server-download', received: 0, total: null, commit: COMMIT },
      { kind: 'server-download', received: 0, total: 200 },
      { kind: 'server-download', received: 100, total: 200 },
    ])
    expect(states.map((s) => s.percent)).toEqual([0, CLI_SHARE / 2, CLI_SHARE, CLI_SHARE, CLI_SHARE, 52.5])
    // The bytes are the current download's: the server's once it starts.
    expect(states.at(-1)).toMatchObject({ received: 100, total: 200, stage: 'download' })
  })

  it("ignores another server version's start while one downloads", () => {
    const downloading = replay(events(LOG.slice(1, 5))).at(-1)!
    expect(reduceVSCodeSetup(downloading, { kind: 'server-starting', commit: OTHER })).toBe(downloading)
    expect(reduceVSCodeSetup(downloading, { kind: 'server-ready', commit: '2d0b750' })).toBe(downloading)
    expect(reduceVSCodeSetup(downloading, { kind: 'server-ready', commit: 'e646868' })).toEqual(IDLE_SETUP)
    expect(reduceVSCodeSetup(downloading, { kind: 'reset' })).toEqual(IDLE_SETUP)
  })

  it('starts an installed server without a download to show', () => {
    const [starting, ready] = replay([{ kind: 'server-starting', commit: OTHER }, { kind: 'server-ready' }])
    expect(starting).toMatchObject({ stage: 'starting', downloaded: false })
    expect(vscodeSetupView(starting, t, 'en')).toEqual({ visible: false, percent: null, label: '' })
    expect(ready).toEqual(IDLE_SETUP)
  })

  it('tells listeners only when what the page shows changes', () => {
    noteVSCodeSetup({ kind: 'reset' })
    const listener = vi.fn()
    const stop = onVSCodeSetupProgress(listener)
    noteVSCodeSetup({ kind: 'server-download', received: 0, total: 229_217_515, commit: COMMIT })
    noteVSCodeSetup({ kind: 'server-download', received: 16_384, total: 229_217_515 })
    noteVSCodeSetup({ kind: 'server-download', received: 2_105_344, total: 229_217_515 })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'download', received: 2_105_344, total: 229_217_515, downloaded: true })
    )
    expect(getVSCodeSetupProgress().stage).toBe('download')
    noteVSCodeSetup({ kind: 'reset' })
    expect(listener).toHaveBeenCalledTimes(3)
    stop()
    noteVSCodeSetup({ kind: 'server-download', received: 1, total: 2 })
    expect(listener).toHaveBeenCalledTimes(3)
    noteVSCodeSetup({ kind: 'reset' })
  })
})

describe('what the loading page shows', () => {
  const at = (events: VSCodeSetupEvent[]) => replay(events).at(-1)!

  it('shows the percent and the megabytes of the download', () => {
    const view = vscodeSetupView(at(events(LOG.slice(1, 5))), t, 'pt-BR')
    expect(view).toEqual({
      visible: true,
      percent: 50,
      label: 'drawerLoading.progressDownload {"percent":50,"received":"116","total":"229"}',
    })
    const cli = vscodeSetupView(at([{ kind: 'cli-download', received: 2_160_000, total: 9_800_000 }]), t, 'pt-BR')
    expect(cli.label).toBe('drawerLoading.progressDownload {"percent":1,"received":"2,2","total":"9,8"}')
  })

  it('animates the bar while the size is unknown, while it installs and while it starts', () => {
    expect(vscodeSetupView(at(events(LOG.slice(1, 2))), t, 'en')).toEqual({
      visible: true,
      percent: 0,
      label: 'drawerLoading.progressDownloading',
    })
    expect(vscodeSetupView(at(events(LOG.slice(1, 6))), t, 'en')).toEqual({
      visible: true,
      percent: null,
      label: 'drawerLoading.progressInstalling',
    })
    expect(vscodeSetupView(at(events(LOG.slice(1, 7))), t, 'en')).toEqual({
      visible: true,
      percent: null,
      label: 'drawerLoading.progressStarting',
    })
    expect(vscodeSetupView(IDLE_SETUP, t, 'en').visible).toBe(false)
  })
})
