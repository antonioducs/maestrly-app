import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXT_JS,
  MEMORY_SNAPSHOT_FILE,
  MEMORY_SNAPSHOT_REQUEST_FILE,
  SELECTION_REL_DIR,
} from '../../src/main/vscode/vscode-ext-source'

interface FakeUri {
  path: string
}

const WORKSPACE = '/workspace'
const snapshotPath = `${WORKSPACE}/${SELECTION_REL_DIR}/${MEMORY_SNAPSHOT_FILE}`
const requestPath = `${WORKSPACE}/${SELECTION_REL_DIR}/${MEMORY_SNAPSHOT_REQUEST_FILE}`

let files: Map<string, string>
let writes: string[]
let subscriptions: Array<{ dispose: () => void }>

function fakeVSCode() {
  const event = () => ({ dispose: () => {} })
  return {
    Uri: { joinPath: (base: FakeUri, ...segments: string[]): FakeUri => ({ path: [base.path, ...segments].join('/') }) },
    workspace: {
      workspaceFolders: [{ uri: { path: WORKSPACE } }],
      textDocuments: [],
      onDidChangeTextDocument: event,
      getWorkspaceFolder: () => undefined,
      fs: {
        createDirectory: async () => {},
        readFile: async (uri: FakeUri) => {
          const content = files.get(uri.path)
          if (content === undefined) throw new Error('ENOENT')
          return new TextEncoder().encode(content)
        },
        writeFile: async (uri: FakeUri, data: Uint8Array) => {
          writes.push(uri.path)
          files.set(uri.path, new TextDecoder().decode(data))
        },
      },
    },
    window: { onDidChangeActiveTextEditor: event },
    debug: { onDidStartDebugSession: event, onDidTerminateDebugSession: event, activeDebugSession: undefined },
    commands: { registerCommand: () => ({ dispose: () => {} }) },
  }
}

function activateBridge(): void {
  const vscode = fakeVSCode()
  const module = { exports: {} as { activate?: (context: { subscriptions: typeof subscriptions }) => void } }
  new Function('require', 'module', EXT_JS)((id: string) => {
    if (id !== 'vscode') throw new Error(`unexpected module ${id}`)
    return vscode
  }, module)
  module.exports.activate?.({ subscriptions })
}

beforeEach(() => {
  vi.useFakeTimers()
  files = new Map()
  writes = []
  subscriptions = []
})

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose()
  vi.useRealTimers()
})

describe('VS Code bridge memory snapshot', () => {
  it('does not write a snapshot sidecar until the app requests one', async () => {
    activateBridge()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(writes).not.toContain(snapshotPath)
    expect(files.has(snapshotPath)).toBe(false)
  })

  it('answers each request with its id', async () => {
    activateBridge()
    files.set(requestPath, JSON.stringify({ id: 'request-1', ts: Date.now() }))
    await vi.advanceTimersByTimeAsync(250)

    expect(JSON.parse(files.get(snapshotPath) ?? 'null')).toMatchObject({
      requestId: 'request-1',
      dirtyDocuments: 0,
      debugActive: false,
      operationInFlight: false,
    })

    files.delete(snapshotPath)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(files.has(snapshotPath)).toBe(false) // the same request is answered once
  })
})
