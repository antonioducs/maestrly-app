/** Preload/IPC contract: capture the exposed API, verify wrapper channels and argument order, check event subscriptions against main emissions, and match every literal invoke/send to exactly one main registration. Read main sources as text to avoid startup side effects. Keep the shared Electron stub instance so spies observe the actual preload; do not reset modules. New main-only channels require a documented KNOWN_MAIN_ONLY entry. */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as electron from 'electron' // Alias to the same stub instance imported by preload.
import { localDataApi } from '../../src/preload/api-local-data'
import { appApi } from '../../src/preload/api-app'
import { chatApi } from '../../src/preload/api-chat'
import { conversationMigrationApi } from '../../src/preload/api-conversation-migration'
import { drawerApi } from '../../src/preload/api-drawer'
import { memoryApi } from '../../src/preload/api-memory'
import { notesApi } from '../../src/preload/api-notes'
import { planApi } from '../../src/preload/api-plan'
import { popupApi } from '../../src/preload/api-popup'
import { ptyApi } from '../../src/preload/api-pty'
import { performanceApi } from '../../src/preload/api-performance'
import { projectSetupApi } from '../../src/preload/api-project-setup'
import { runtimeAssetsApi } from '../../src/preload/api-runtime-assets'
import { reviewApi } from '../../src/preload/api-review'
import { settingsApi } from '../../src/preload/api-settings'
import { soundApi } from '../../src/preload/api-sound'
import { workspaceApi } from '../../src/preload/api-workspace'
import { platformApi } from '../../src/preload/api-platform'

type Fn = (...args: unknown[]) => unknown
type Api = Record<string, Fn>

// Install spies before beforeAll imports preload so every IPC call is captured.
// Wrapper invocations are recorded in their respective mock.calls.
const exposeSpy = vi.spyOn(electron.contextBridge, 'exposeInMainWorld')
const invokeSpy = vi.spyOn(electron.ipcRenderer, 'invoke')
const sendSpy = vi.spyOn(electron.ipcRenderer, 'send')
const onSpy = vi.spyOn(electron.ipcRenderer, 'on')
const removeListenerSpy = vi.spyOn(electron.ipcRenderer, 'removeListener')
const clipboardWriteSpy = vi.spyOn(electron.clipboard, 'writeText')

let api: Api
const apiSlices: Array<[string, Record<string, unknown>]> = [
  ['appApi', appApi],
  ['localDataApi', localDataApi],
  ['ptyApi', ptyApi],
  ['performanceApi', performanceApi],
  ['workspaceApi', workspaceApi],
  ['conversationMigrationApi', conversationMigrationApi],
  ['projectSetupApi', projectSetupApi],
  ['runtimeAssetsApi', runtimeAssetsApi],
  ['memoryApi', memoryApi],
  ['notesApi', notesApi],
  ['drawerApi', drawerApi],
  ['popupApi', popupApi],
  ['planApi', planApi],
  ['reviewApi', reviewApi],
  ['settingsApi', settingsApi],
  ['soundApi', soundApi],
  ['chatApi', chatApi],
  ['platformApi', platformApi],
]
beforeAll(async () => {
  await import('../../src/preload/index') // Runs contextBridge.exposeInMainWorld('api', api).
  const call = exposeSpy.mock.calls.find((c) => c[0] === 'api')
  api = call?.[1] as Api
  expect(api).toBeTruthy()
})
beforeEach(() => {
  invokeSpy.mockClear()
  sendSpy.mockClear()
  onSpy.mockClear()
  removeListenerSpy.mockClear()
  clipboardWriteSpy.mockClear()
})

const mainDir = fileURLToPath(new URL('../../src/main', import.meta.url))
const preloadDir = fileURLToPath(new URL('../../src/preload', import.meta.url))
const readTsFiles = (rootDir: string): Map<string, string> => {
  const files = new Map<string, string>()

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(abs)
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.set(relative(rootDir, abs).replace(/\\/g, '/'), readFileSync(abs, 'utf8'))
      }
    }
  }

  visit(rootDir)
  return files
}
const readMainFiles = (): Map<string, string> => readTsFiles(mainDir)
const readPreloadFiles = (): Map<string, string> => readTsFiles(preloadDir)

const collectFirstCapture = (text: string, re: RegExp): Set<string> => {
  const out = new Set<string>()
  for (const m of text.matchAll(re)) out.add(m[1])
  return out
}

const collectMainChannelFiles = (re: RegExp): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  for (const [file, text] of mainFiles) {
    for (const m of text.matchAll(re)) {
      const channel = m[1]
      const files = out.get(channel) ?? []
      files.push(file)
      out.set(channel, files)
    }
  }
  return out
}

const MAIN_REGISTRATION_RE = /(?:ipcMain\.(?:handle|on)|\breg\.(?:handle|on)|\bmhandle|\bmon)\(\s*'([^']+)'/g
const PRELOAD_API_CHANNEL_RE = /ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g
const PRELOAD_LISTENER_CHANNEL_RE = /ipcRenderer\.on\(\s*'([^']+)'/g

// Main registrations without preload consumers require an explicit explanation.
const KNOWN_MAIN_ONLY: string[] = []

// Read sources without importing them to inventory channels and event emissions.
const mainFiles = readMainFiles()
const mainText = [...mainFiles.values()].join('\n')
const preloadFiles = readPreloadFiles()
const preloadText = [...preloadFiles.values()].join('\n')

// ---------------------------------------------------------------------------
// Verify the exposed API includes core workspace wrappers.
// ---------------------------------------------------------------------------
describe('preload API — exposure', () => {
  it('exposes an api object through contextBridge with conversation wrappers', () => {
    expect(typeof api).toBe('object')
    expect(typeof api.onConversationOpen).toBe('function')
    expect(typeof api.createSiblingConversation).toBe('function')
    expect(typeof api.getConversationBranchInfo).toBe('function')
  })

  it('exposes synchronous platformInfo with OS, titlebar offset, and open labels (#167)', () => {
    const p = (api as Record<string, unknown>).platformInfo as {
      os: string
      ttOffset: number
      openLabels: { terminal: string; files: string }
    }
    expect(p).toBeTruthy()
    expect(['mac', 'win', 'linux']).toContain(p.os)
    expect(typeof p.ttOffset).toBe('number')
    expect(typeof p.openLabels.terminal).toBe('string')
    expect(typeof p.openLabels.files).toBe('string')
  })

  it('preserves the public preload API inventory', () => {
    const keys = Object.keys(api)
    expect(keys).toHaveLength(368)
    expect(keys.sort()).toMatchSnapshot()
  })

  it('composes disjoint slices whose union equals the exposed API', () => {
    const apiKeys = Object.keys(api).sort()
    const ownerByKey = new Map<string, string[]>()

    for (const [sliceName, slice] of apiSlices) {
      for (const key of Object.keys(slice)) {
        const owners = ownerByKey.get(key) ?? []
        owners.push(sliceName)
        ownerByKey.set(key, owners)
      }
    }

    const duplicateKeys = [...ownerByKey.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([key, owners]) => `${key}: ${owners.join(', ')}`)
      .sort()
    const sliceKeys = [...ownerByKey.keys()].sort()
    const sliceKeyCount = apiSlices.reduce((sum, [, slice]) => sum + Object.keys(slice).length, 0)

    expect(duplicateKeys).toEqual([])
    expect(sliceKeyCount).toBe(apiKeys.length)
    expect(sliceKeys).toEqual(apiKeys)
  })
})

// ---------------------------------------------------------------------------
// Verify invoke channels and argument order for sensitive wrappers.
// Distinct sentinel arguments make accidental reordering fail the assertion.
// ---------------------------------------------------------------------------
describe('preload API — channels and argument order (ipcRenderer.invoke)', () => {
  it('runtime assets preserve IDs and explicit channels', () => {
    api.runtimeAssetStatus('codex-runtime')
    expect(invokeSpy).toHaveBeenLastCalledWith('runtime-assets:status', 'codex-runtime')
    api.runtimeAssetList()
    expect(invokeSpy).toHaveBeenLastCalledWith('runtime-assets:list')
    api.runtimeAssetInstall('github-copilot-runtime')
    expect(invokeSpy).toHaveBeenLastCalledWith('runtime-assets:install', 'github-copilot-runtime')
    api.runtimeAssetCancel('tunnel-client')
    expect(invokeSpy).toHaveBeenLastCalledWith('runtime-assets:cancel', 'tunnel-client')
    api.runtimeAssetRepair('codex-runtime')
    expect(invokeSpy).toHaveBeenLastCalledWith('runtime-assets:repair', 'codex-runtime')
    api.runtimeAssetRemove('local-ml-runtime')
    expect(invokeSpy).toHaveBeenLastCalledWith('runtime-assets:remove', 'local-ml-runtime')
  })

  it('project setup preserves channels and discriminated payloads', () => {
    const request = { operationId: '00000000-0000-4000-8000-000000000001', kind: 'open' as const, path: '/repo' }
    api.pickProjectDirectory('parent')
    api.startProjectSetup(request)
    api.cancelProjectSetup(request.operationId)
    api.resolveEmptyRemoteProjectSetup(request.operationId, 'initialize-local')
    expect(invokeSpy.mock.calls).toEqual([
      ['project-setup:pick-directory', 'parent'],
      ['project-setup:start', request],
      ['project-setup:cancel', request.operationId],
      ['project-setup:resolve-empty-remote', { operationId: request.operationId, decision: 'initialize-local' }],
    ])
  })

  it('setWorkspaceDefaultBranch(ws,branch) -> workspace:set-default-branch (invoke)', () => {
    api.setWorkspaceDefaultBranch('ws', 'stage')
    expect(invokeSpy).toHaveBeenCalledWith('workspace:set-default-branch', 'ws', 'stage')
    expect(sendSpy).not.toHaveBeenCalled() // Invoke lets the UI await and handle rejection of an empty value.
  })

  it('reorderWorkspaces(ids) -> workspace:reorder', () => {
    api.reorderWorkspaces(['a', 'b'])
    expect(invokeSpy).toHaveBeenCalledWith('workspace:reorder', ['a', 'b'])
  })

  it('reorderConversations(ws,ids) -> conversation:reorder', () => {
    api.reorderConversations('ws', ['c1', 'c2'])
    expect(invokeSpy).toHaveBeenCalledWith('conversation:reorder', 'ws', ['c1', 'c2'])
  })

  it('setConversationPinned(id,pinned) -> conversation:pin in exact argument order', () => {
    api.setConversationPinned('conv-1', true)
    expect(invokeSpy).toHaveBeenCalledWith('conversation:pin', 'conv-1', true)
    api.setConversationPinned('conv-2', false)
    expect(invokeSpy).toHaveBeenLastCalledWith('conversation:pin', 'conv-2', false)
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(sendSpy).not.toHaveBeenCalled() // Invoke lets the UI await the canonical pin timestamp.
  })

  // Workspace groups: sensitive wrapper argument order (#218).
  it('createGroup(name) -> group:create', () => {
    api.createGroup('Backend')
    expect(invokeSpy).toHaveBeenCalledWith('group:create', 'Backend')
  })

  it('reorderGroups(ids) -> group:reorder', () => {
    api.reorderGroups(['g1', 'g2'])
    expect(invokeSpy).toHaveBeenCalledWith('group:reorder', ['g1', 'g2'])
  })

  it('moveWorkspaceToGroup(wsId,groupId,flatIds) -> group:assign in exact argument order', () => {
    api.moveWorkspaceToGroup('ws', 'g', ['a', 'b'])
    expect(invokeSpy).toHaveBeenCalledWith('group:assign', 'ws', 'g', ['a', 'b'])
  })

  it('moveWorkspaceToGroup(wsId,null,flatIds) assigns the workspace to the ungrouped list', () => {
    api.moveWorkspaceToGroup('ws', null, ['a'])
    expect(invokeSpy).toHaveBeenCalledWith('group:assign', 'ws', null, ['a'])
  })

  it('Local prepare and confirm forward the object without a raw path', () => {
    const prepare = {
      workspaceId: 'ws',
      intent: { type: 'create-from-head' as const, branch: 'feature/x' },
    }
    api.prepareLocalConversation(prepare)
    expect(invokeSpy).toHaveBeenCalledWith('conversation:local-prepare', prepare)
    api.confirmLocalConversation({ token: 'opaque' })
    expect(invokeSpy).toHaveBeenCalledWith('conversation:local-confirm', { token: 'opaque' })
  })

  it('migration wrappers preserve payloads and static channels', () => {
    const prepare = { conversationId: 'c1', destinationBranch: 'feature/x' }
    const execute = {
      operationId: 'op',
      selectedIgnoredPaths: ['cache'],
      confirmedSensitivePaths: ['cache'],
    }
    const resolve = { operationId: 'op', action: 'rollback' as const }
    api.prepareConversationMigration(prepare)
    api.executeConversationMigration(execute)
    api.cancelConversationMigration({ operationId: 'op' })
    api.listConversationMigrationRecoveries()
    api.resolveConversationMigration(resolve)
    expect(invokeSpy.mock.calls).toEqual([
      ['conversation:migration-prepare', prepare],
      ['conversation:migration-execute', execute],
      ['conversation:migration-cancel', { operationId: 'op' }],
      ['conversation:migration-list-recoveries'],
      ['conversation:migration-resolve', resolve],
    ])
  })

  it('createSiblingConversation(args) -> conversation:createSibling preserves the argument object', () => {
    const args = { sourceConversationId: 'conv-origem' }
    api.createSiblingConversation(args)
    expect(invokeSpy).toHaveBeenCalledWith('conversation:createSibling', args)
  })

  it('getConversationBranchInfo(id) sends only the ID, without a path', () => {
    api.getConversationBranchInfo('conv-1')
    expect(invokeSpy).toHaveBeenCalledWith('conversation:branch-info', 'conv-1')
  })

})

// ---------------------------------------------------------------------------
// Popup opening is fire-and-forget and uses ipcRenderer.send.
// ---------------------------------------------------------------------------
describe('preload API — popup opening uses SEND', () => {
  it('popupOpenFloating(conv,tab) forwards arguments in exact order', () => {
    api.popupOpenFloating('conv', 'notes')
    expect(sendSpy).toHaveBeenCalledWith('popup:open-floating', 'conv', 'notes')
    expect(invokeSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Main-to-renderer events: subscribe, return unsubscribe, and verify main emission.
// ---------------------------------------------------------------------------
describe('preload API — main-to-renderer events (ipcRenderer.on)', () => {
  it('onToggleDrawerShortcut registers drawer:toggle-shortcut and removes the exact listener', () => {
    const callback = vi.fn()
    const off = api.onToggleDrawerShortcut(callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('drawer:toggle-shortcut', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown, convId: string) => void
    listener({}, 'conv-1')
    expect(callback).toHaveBeenCalledWith('conv-1')
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('drawer:toggle-shortcut', listener)
  })

  it('onConversationMigrationChanged registers a static channel and removes the exact listener', () => {
    const callback = vi.fn()
    const off = api.onConversationMigrationChanged(callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('conversation:migration-changed', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    const payload = {
      operationId: 'op',
      phase: 'awaiting-validation',
      status: 'awaiting-validation',
      conversationId: 'c1',
    }
    listener({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('conversation:migration-changed', listener)
    expect(mainText).toContain("broadcast('conversation:migration-changed'")
  })

  it('onProjectSetupProgress registers a static channel and removes the exact listener', () => {
    const callback = vi.fn()
    const off = api.onProjectSetupProgress(callback) as () => void
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(onSpy.mock.calls[0]?.[0]).toBe('project-setup:progress')
    const registered = onSpy.mock.calls[0]?.[1]
    expect(typeof registered).toBe('function')
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('project-setup:progress', registered)
  })

  it('soundApi covers all three channels and removes its listener on cleanup', () => {
    const cb = vi.fn()
    const off = api.onSoundPlay(cb) as () => void
    expect(onSpy).toHaveBeenCalledWith('sound:play', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    const request = {
      requestId: 'r1',
      voice: 'glass',
      volume: 0.5,
      expiresAt: Date.now() + 1000,
      data: new ArrayBuffer(1),
    }
    listener({}, request)
    expect(cb).toHaveBeenCalledWith(request)
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('sound:play', listener)

    api.setSoundRendererReady()
    expect(sendSpy).toHaveBeenCalledWith('sound:renderer-ready')
    const ack = { requestId: 'r1', status: 'started' }
    api.ackSoundPlay(ack)
    expect(sendSpy).toHaveBeenCalledWith('sound:ack', ack)
  })

  it('onConversationOpen forwards the payload and removes the exact listener', () => {
    const callback = vi.fn()
    const off = api.onConversationOpen(callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('conversation:open', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    const payload = { conversation: { id: 'conversation-1' }, focus: true }
    listener({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('conversation:open', listener)
  })

  it('onChatModelsCatalogChanged forwards global invalidation and removes the exact listener', () => {
    const callback = vi.fn()
    const off = api.onChatModelsCatalogChanged(callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('models:catalog-changed', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown) => void
    listener({})
    expect(callback).toHaveBeenCalledTimes(1)
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('models:catalog-changed', listener)
    expect(mainText).toContain("broadcast('models:catalog-changed')")
  })

  it('onTerminalPanelActivity registers the channel, delivers state, and removes its listener', () => {
    const callback = vi.fn()
    const off = api.onTerminalPanelActivity(callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('drawer:terminal-activity', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    const state = { convId: 'conv-terminal', fullSpeed: false }
    listener({}, state)
    expect(callback).toHaveBeenCalledWith(state)
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('drawer:terminal-activity', listener)
  })

  it('onMemoryAutoReclaimChanged synchronizes state and removes its listener', () => {
    const callback = vi.fn()
    const off = api.onMemoryAutoReclaimChanged(callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('performance:auto-reclaim-changed', expect.any(Function))
    const listener = onSpy.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void
    const state = { enabled: false }
    listener({}, state)
    expect(callback).toHaveBeenCalledWith(state)
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('performance:auto-reclaim-changed', listener)
    expect(mainText).toContain('performance:auto-reclaim-changed')
  })

  it('main emits conversation-open events in its source corpus', () => {
    expect(mainText).toContain("'conversation:open'")
  })
})

// ---------------------------------------------------------------------------
// Sidebar workspace and conversation reordering channels are registered in main (#31).
// ---------------------------------------------------------------------------
describe('channel cross-check sidebar reorder (preload -> main)', () => {
  it('workspace:reorder and conversation:reorder exist in main and preload', () => {
    expect(mainText).toMatch(/(?:ipcMain\.handle|\bmhandle)\(\s*'workspace:reorder'/)
    expect(mainText).toMatch(/(?:ipcMain\.handle|\bmhandle)\(\s*'conversation:reorder'/)
    expect(preloadText).toContain("ipcRenderer.invoke('workspace:reorder'")
    expect(preloadText).toContain("ipcRenderer.invoke('conversation:reorder'")
  })
})

// ---------------------------------------------------------------------------
// Workspace default branch uses a dedicated workspace channel (#557).
// ---------------------------------------------------------------------------
describe('channel cross-check workspace:set-default-branch (preload -> main)', () => {
  it('workspace:set-default-branch exists in main and preload', () => {
    expect(mainText).toMatch(/(?:ipcMain\.handle|\bmhandle)\(\s*'workspace:set-default-branch'/)
    expect(preloadText).toContain("ipcRenderer.invoke('workspace:set-default-branch'")
  })
})

// ---------------------------------------------------------------------------
// Sibling conversation channel is public in preload and validated in main (#322).
// ---------------------------------------------------------------------------
describe('channel cross-check conversation:createSibling (preload -> main)', () => {
  it('conversation:createSibling exists in main and preload', () => {
    expect(mainText).toMatch(/(?:ipcMain\.handle|\bmhandle)\(\s*'conversation:createSibling'/)
    expect(preloadText).toContain("ipcRenderer.invoke('conversation:createSibling'")
  })
})

// ---------------------------------------------------------------------------
// Sidebar pinning uses conversation:pin with main mhandle and preload invoke.
// ---------------------------------------------------------------------------
describe('channel cross-check conversation:pin (preload -> main)', () => {
  it('conversation:pin uses main mhandle and preload invoke', () => {
    expect(mainText).toMatch(/\bmhandle\(\s*'conversation:pin'/)
    expect(preloadText).toContain("ipcRenderer.invoke('conversation:pin'")
  })
})

// ---------------------------------------------------------------------------
// Workspace group collapse uses send; group channels match main registrations (#218).
// Group channels have their own prefix inventory.
// ---------------------------------------------------------------------------
describe('preload API — workspace groups send collapse changes (#218)', () => {
  it('setGroupCollapsed(id,b) sends group:set-collapsed without invoke', () => {
    api.setGroupCollapsed('g', true)
    expect(sendSpy).toHaveBeenCalledWith('group:set-collapsed', 'g', true)
    expect(invokeSpy).not.toHaveBeenCalled()
  })
  it('setWorkspaceCollapsed(id,b) sends workspace:set-collapsed without invoke', () => {
    api.setWorkspaceCollapsed('ws', true)
    expect(sendSpy).toHaveBeenCalledWith('workspace:set-collapsed', 'ws', true)
    expect(invokeSpy).not.toHaveBeenCalled()
  })
})

describe('channel cross-check group:* (preload -> main)', () => {
  const collect = (text: string, re: RegExp): Set<string> => {
    const out = new Set<string>()
    for (const m of text.matchAll(re)) out.add(m[1])
    return out
  }
  const mainChannels = collect(
    mainText,
    /(?:ipcMain\.(?:handle|on)|\breg\.(?:handle|on)|\bmhandle|\bmon)\(\s*'(group:[^']+)'/g
  )
  const apiChannels = collect(preloadText, /ipcRenderer\.(?:invoke|send)\(\s*'(group:[^']+)'/g)

  it('extracts group channels from both sides to verify the regex', () => {
    expect(mainChannels.size).toBeGreaterThan(0)
    expect(apiChannels.size).toBeGreaterThan(0)
  })

  it('every preload group channel is registered in main', () => {
    const missing = [...apiChannels].filter((ch) => !mainChannels.has(ch)).sort()
    expect(missing).toEqual([])
  })

  it('group channels are registered in main (#218)', () => {
    for (const ch of [
      'group:list',
      'group:create',
      'group:rename',
      'group:delete',
      'group:reorder',
      'group:assign',
      'group:set-collapsed',
    ]) {
      expect(mainChannels.has(ch)).toBe(true)
    }
  })

  it('workspace:set-collapsed exists in main and preload as a send pair', () => {
    expect(mainText).toMatch(/(?:ipcMain\.on|\bmon)\(\s*'workspace:set-collapsed'/)
    expect(preloadText).toContain("ipcRenderer.send('workspace:set-collapsed'")
  })
})

// ---------------------------------------------------------------------------
// CLI detection and settings wrappers match main registrations (#132).
// Check settings and runtime prefixes separately.
// ---------------------------------------------------------------------------
describe('preload API — Chat settings wrappers', () => {
  it('forwards Design mode through the existing chat mode IPC channel', () => {
    api.chatSetMode('conversation-design', 'design')
    expect(invokeSpy).toHaveBeenCalledWith('chat:set-mode', 'conversation-design', 'design')
    api.chatGetMode('conversation-design')
    expect(invokeSpy).toHaveBeenCalledWith('chat:get-mode', 'conversation-design')
  })

  it('setDrawerShortcut(binding) -> settings:drawer-shortcut-set (send)', () => {
    const binding = { key: 'd', mods: ['meta', 'control'] as Array<'meta' | 'control'> }
    api.setDrawerShortcut(binding)
    expect(sendSpy).toHaveBeenCalledWith('settings:drawer-shortcut-set', binding)
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('getDefaultPermissionMode -> chat:default-permission-mode-get (invoke)', () => {
    api.getDefaultPermissionMode()
    expect(invokeSpy).toHaveBeenCalledWith('chat:default-permission-mode-get')
  })
  it('setDefaultPermissionMode -> chat:default-permission-mode-set (send)', () => {
    api.setDefaultPermissionMode('ask')
    expect(sendSpy).toHaveBeenCalledWith('chat:default-permission-mode-set', 'ask')
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('getOnboardingDone -> settings:onboarding-get (invoke) [#145]', () => {
    api.getOnboardingDone()
    expect(invokeSpy).toHaveBeenCalledWith('settings:onboarding-get')
  })
  it('setOnboardingDone(b) sends settings:onboarding-set without invoke (#145)', () => {
    api.setOnboardingDone(true)
    expect(sendSpy).toHaveBeenCalledWith('settings:onboarding-set', true)
    expect(invokeSpy).not.toHaveBeenCalled()
  })

  it('onPtyData subscribes in main and unsubscribe closes the paired subscription', () => {
    const off = api.onPtyData('agent-1', () => {})
    expect(onSpy).toHaveBeenCalledWith('pty:data:agent-1', expect.any(Function))
    expect(sendSpy).toHaveBeenCalledWith('pty:subscribe', 'agent-1')

    ;(off as () => void)()
    expect(removeListenerSpy).toHaveBeenCalledWith('pty:data:agent-1', expect.any(Function))
    expect(sendSpy).toHaveBeenCalledWith('pty:unsubscribe', 'agent-1')
  })
  it('onPtyData unwraps generation and sequence while supporting string payloads', () => {
    const cb = vi.fn()
    api.onPtyData('agent-2', cb)
    const registration = onSpy.mock.calls.find((args) => args[0] === 'pty:data:agent-2')
    const listener = registration?.[1] as ((_event: unknown, payload: unknown) => void) | undefined
    listener?.({}, { data: 'chunk', generation: 4, sequence: 9 })
    listener?.({}, 'legacy')

    expect(cb).toHaveBeenNthCalledWith(1, 'chunk', { generation: 4, sequence: 9 })
    expect(cb).toHaveBeenNthCalledWith(2, 'legacy')
  })
  it('onChatStream/onChatPermission subscribe by conversation; each unsubscribe releases one reference', () => {
    const offStream = api.onChatStream('chat-1', () => {}) as () => void
    const offPermission = api.onChatPermission('chat-1', () => {}) as () => void

    expect(sendSpy).toHaveBeenNthCalledWith(1, 'chat:subscribe', 'chat-1')
    expect(sendSpy).toHaveBeenNthCalledWith(2, 'chat:subscribe', 'chat-1')

    offStream()
    expect(sendSpy).toHaveBeenNthCalledWith(3, 'chat:unsubscribe', 'chat-1')
    offStream()
    expect(sendSpy).toHaveBeenCalledTimes(3)

    offPermission()
    expect(sendSpy).toHaveBeenNthCalledWith(4, 'chat:unsubscribe', 'chat-1')
  })
  it('onChatSubagentSession shares the conversation subscription reference', () => {
    const callback = vi.fn()
    const off = api.onChatSubagentSession('chat-child', callback) as () => void
    expect(onSpy).toHaveBeenCalledWith('chat:subagent-session:chat-child', expect.any(Function))
    expect(sendSpy).toHaveBeenCalledWith('chat:subscribe', 'chat-child')
    const listener = onSpy.mock.calls.find((args) => args[0] === 'chat:subagent-session:chat-child')?.[1] as (
      event: unknown,
      payload: unknown
    ) => void
    listener({}, { conversationId: 'chat-child', sessionId: 'subagent-1', revision: 3 })
    expect(callback).toHaveBeenCalledWith({ conversationId: 'chat-child', sessionId: 'subagent-1', revision: 3 })
    off()
    expect(sendSpy).toHaveBeenCalledWith('chat:unsubscribe', 'chat-child')
  })
})

describe('channel cross-check settings:* (preload -> main)', () => {
  const collect = (text: string, re: RegExp): Set<string> => {
    const out = new Set<string>()
    for (const m of text.matchAll(re)) out.add(m[1])
    return out
  }
  const mainChannels = collect(
    mainText,
    /(?:ipcMain\.(?:handle|on)|\breg\.(?:handle|on)|\bmhandle|\bmon)\(\s*'((?:settings|telemetry):[^']+)'/g
  )
  const apiChannels = collect(preloadText, /ipcRenderer\.(?:invoke|send)\(\s*'((?:settings|telemetry):[^']+)'/g)

  it('extracts CLI and settings channels from both sides to verify the regex', () => {
    expect(mainChannels.size).toBeGreaterThan(0)
    expect(apiChannels.size).toBeGreaterThan(0)
  })

  it('every preload CLI and settings channel is registered in main', () => {
    const missing = [...apiChannels].filter((ch) => !mainChannels.has(ch)).sort()
    expect(missing).toEqual([])
  })

  it('onboarding channels are registered in main (#145)', () => {
    for (const ch of ['settings:onboarding-get', 'settings:onboarding-set']) {
      expect(mainChannels.has(ch)).toBe(true)
    }
  })

})

// ---------------------------------------------------------------------------
// Local ownership: export, inspect, and reset the application data on this device.
describe('preload local data API', () => {
  it.each([
    ['exportData', 'data:export'],
    ['getLocalDataSummary', 'data:local-summary'],
    ['resetLocalData', 'data:reset'],
  ])('%s invokes %s without account credentials', (method, channel) => {
    api[method]()
    expect(invokeSpy).toHaveBeenCalledWith(channel)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(mainText).toContain(`'${channel}'`)
  })

  it('does not expose hosted account, cloud, telemetry, or update methods', () => {
    for (const method of [
      'login', 'logout', 'getLicenseState', 'getDeviceId', 'onLicenseChanged', 'onSessionRevoked',
      'acceptLegal', 'refreshLegalStatus', 'deleteAccount', 'reactivateAccount',
      'accountLocalDataSummary', 'getTelemetryEnabled', 'setTelemetryEnabled', 'trackFeature',
      'notifySessionStarted', 'getCrashReportingEnabled', 'setCrashReportingEnabled',
      'getFeedbackDiagnostic', 'submitFeedback',
    ]) expect(api).not.toHaveProperty(method)
    expect(Object.keys(api).filter((key) => /^cloud/i.test(key))).toEqual([])
    const removedChannels = [...collectFirstCapture(preloadText, PRELOAD_API_CHANNEL_RE)]
      .filter((channel) => /^(auth|license|legal|account|cloud-project|cloud-runner|telemetry|update|feedback):/.test(channel))
    expect(removedChannels).toEqual([])
  })
})

// Review merge conflict resolution uses invoke and sender validation (#321).
// The mutation must use mhandle sender validation rather than a read-only ipcMain.handle.
// ---------------------------------------------------------------------------
describe('preload API — merge conflict resolution (#321)', () => {
  it('resolveConflicts(convId,opts) -> review:resolve-conflicts in exact argument order (invoke)', () => {
    api.resolveConflicts('c1', { providerId: 'builtin_codex_subscription', modelId: 'gpt-5.5', reasoning: 'high' })
    expect(invokeSpy).toHaveBeenCalledWith('review:resolve-conflicts', 'c1', {
      providerId: 'builtin_codex_subscription',
      modelId: 'gpt-5.5',
      reasoning: 'high',
    })
  })

  it('getReview(convId) -> review:get (invoke)', () => {
    api.getReview('c1')
    expect(invokeSpy).toHaveBeenCalledWith('review:get', 'c1')
  })

  it('review:resolve-conflicts uses mhandle with guardHandle, not ipcMain.handle', () => {
    // AI worktree writes require sender allowlist validation.
    expect(mainText).toMatch(/\bmhandle\(\s*'review:resolve-conflicts'/)
    expect(mainText).not.toMatch(/ipcMain\.handle\(\s*'review:resolve-conflicts'/)
    // Read-only review:get retains its ipcMain.handle registration.
    expect(mainText).toMatch(/(?:ipcMain\.handle|\breg\.handle)\(\s*'review:get'/)
  })
})

// ---------------------------------------------------------------------------
// Chat history pagination wrappers match registrations throughout main (#559).
// Chat channels may be registered in any main module.
// Registrations must follow the canonical forms inventoried below.
// ---------------------------------------------------------------------------
describe('preload API — chat pagination (#559)', () => {
  it('routes the shared subscription authentication lifecycle for each provider', () => {
    api.chatSubscriptionStatus('codex-subscription', true)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:codex-subscription:status', { refresh: true })
    api.chatSubscriptionLogin('codex-subscription')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:codex-subscription:login')
    api.chatSubscriptionLogout('codex-subscription')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:codex-subscription:logout')

    api.chatSubscriptionStatus('github-copilot-subscription', false)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:github-copilot-subscription:status', { refresh: false })
    api.chatSubscriptionLogin('github-copilot-subscription')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:github-copilot-subscription:login')
    api.chatSubscriptionLogout('github-copilot-subscription')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:github-copilot-subscription:logout')

    api.chatSubscriptionStatus('claude-subscription', true)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:claude-subscription:status', { refresh: true })
    api.chatSubscriptionLogin('claude-subscription')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:claude-subscription:login')
    api.chatSubscriptionLogout('claude-subscription')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:claude-subscription:logout')
  })

  it('preserves provider, force, and accountId in official subscription usage snapshots', () => {
    api.chatSubscriptionUsage('codex-subscription', false)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subscription-usage', {
      providerKind: 'codex-subscription',
      force: false,
    })

    api.chatSubscriptionUsage('claude-subscription', true, 'acc_work')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subscription-usage', {
      providerKind: 'claude-subscription',
      force: true,
      accountId: 'acc_work',
    })
  })

  it('exposes the Codex Subscription authentication lifecycle on dedicated channels', () => {
    api.chatCodexSubscriptionStatus(true)
    expect(invokeSpy).toHaveBeenCalledWith('chat:codex-subscription:status', { refresh: true })

    api.chatCodexSubscriptionLogin()
    expect(invokeSpy).toHaveBeenCalledWith('chat:codex-subscription:login')

    api.chatCodexSubscriptionLogout()
    expect(invokeSpy).toHaveBeenCalledWith('chat:codex-subscription:logout')
  })

  it('subscribes to Codex Subscription authentication changes and returns unsubscribe', () => {
    const callback = vi.fn()
    const status = { state: 'signed-in', authenticated: true, email: 'dev@example.com' }
    const off = api.onChatCodexSubscriptionStatus(callback) as () => void
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(onSpy.mock.calls[0]?.[0]).toBe('chat:codex-subscription:auth-changed')

    const listener = onSpy.mock.calls[0]?.[1] as (...args: unknown[]) => void
    listener({}, status)
    expect(callback).toHaveBeenCalledWith(status)

    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('chat:codex-subscription:auth-changed', listener)
  })

  it('subscribes to GitHub Copilot authentication changes and returns unsubscribe', () => {
    const callback = vi.fn()
    const status = { state: 'signing-in', authenticated: false, username: 'octocat' }
    const off = api.onChatSubscriptionStatus('github-copilot-subscription', callback) as () => void
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(onSpy.mock.calls[0]?.[0]).toBe('chat:github-copilot-subscription:auth-changed')

    const listener = onSpy.mock.calls[0]?.[1] as (...args: unknown[]) => void
    listener({}, status)
    expect(callback).toHaveBeenCalledWith(status)

    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('chat:github-copilot-subscription:auth-changed', listener)
  })

  it('subscribes to Claude authentication changes and returns unsubscribe', () => {
    const callback = vi.fn()
    const status = { state: 'signed-in', authenticated: true, email: 'dev@example.com', planType: 'max' }
    const off = api.onChatSubscriptionStatus('claude-subscription', callback) as () => void
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(onSpy.mock.calls[0]?.[0]).toBe('chat:claude-subscription:auth-changed')

    const listener = onSpy.mock.calls[0]?.[1] as (...args: unknown[]) => void
    listener({}, status)
    expect(callback).toHaveBeenCalledWith(status)

    off()
    expect(removeListenerSpy).toHaveBeenCalledWith('chat:claude-subscription:auth-changed', listener)
  })

  it('chatSetBashFilters(enabled) -> chat:set-bash-filters preserves the boolean', () => {
    api.chatSetBashFilters(false)
    expect(invokeSpy).toHaveBeenCalledWith('chat:set-bash-filters', false)
  })

  it('chatSetOpenAIHarness(enabled) -> chat:set-openai-harness preserves the boolean', () => {
    api.chatSetOpenAIHarness(false)
    expect(invokeSpy).toHaveBeenCalledWith('chat:set-openai-harness', false)
  })

  it('exposes Astra kill switch and active-turn controls without remote identifiers', () => {
    api.chatSetAstraHarness(false)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:set-astra-harness', false)
    api.chatSteer('conversation-1', 'also verify lint', 'client-message-1')
    expect(invokeSpy).toHaveBeenLastCalledWith(
      'chat:steer',
      'conversation-1',
      'also verify lint',
      'client-message-1'
    )
    api.chatUpdateLiveReasoning('conversation-1', 'ultra')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:update-live-reasoning', 'conversation-1', 'ultra')
  })

  it('subagent profiles preserve channels and argument order', () => {
    const rules = { version: 1, default: [{ providerId: 'p', modelId: 'm', effort: 'high' }] }
    api.chatSubagentProfilesSetGlobal(rules)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:set-global', rules)
    api.chatSubagentProfilesGetConversation('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:get-conversation', 'c1')
    api.chatSubagentProfilesSetConversation('c1', rules)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:set-conversation', 'c1', rules)
    api.chatSubagentProfilesSetConversationEnabled('c1', false)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:set-conversation-enabled', 'c1', false)
    api.chatSubagentsSetConversationEnabled('c1', false)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagents:set-conversation-enabled', 'c1', false)
    api.chatSubagentProfilesCatalog('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:catalog', 'c1')
    api.chatSubagentProfilesModelCatalog('p')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:model-catalog', 'p')
    api.chatSubagentProfilesModelMeta('p', 'm')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:subagent-profiles:model-meta', 'p', 'm')
  })

  it('Maestro configuration preserves global and conversation scope and argument order', () => {
    const config = {
      version: 1,
      strategy: 'balanced',
      pool: [],
    } as any
    api.chatMaestroGetGlobal()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:get-global')
    api.chatMaestroSetGlobal(config)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:set-global', config)
    api.chatMaestroGetConversation('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:get-conversation', 'c1')
    api.chatMaestroSetConversation('c1', config)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:set-conversation', 'c1', config)
    api.chatMaestroConvertToStandard('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:convert-to-standard', 'c1')
    api.chatStandardConvertToMaestro('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:standard:convert-to-maestro', 'c1')

    const orchestrator = { providerId: 'p', modelId: 'm', reasoning: 'high', fastMode: true }
    const input = { name: 'Premium', config, orchestrator }
    api.chatMaestroStrategyProfilesList()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:strategy-profiles:list')
    api.chatMaestroStrategyProfilesCreate(input)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:strategy-profiles:create', input)
    api.chatMaestroStrategyProfilesUpdate('profile-1', input)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:strategy-profiles:update', 'profile-1', input)
    api.chatMaestroStrategyProfilesDelete('profile-1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro:strategy-profiles:delete', 'profile-1')
  })

  it('Maestro configurator preserves profile, draft, hash, and turn lifecycle', () => {
    const profile = { providerId: 'p', modelId: 'm', effort: 'high', fastMode: true }
    const draft = { version: 1, strategy: 'balanced', pool: [] } as any
    api.chatMaestroConfiguratorState()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro-configurator:state')
    api.chatMaestroConfiguratorSetProfile(profile)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro-configurator:set-profile', profile)
    api.chatMaestroConfiguratorSend({ text: 'configure', draft, baseHash: 'hash-1' })
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro-configurator:send', {
      text: 'configure',
      draft,
      baseHash: 'hash-1',
    })
    api.chatMaestroConfiguratorCancel('turn-1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro-configurator:cancel', 'turn-1')
    api.chatMaestroConfiguratorReset()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:maestro-configurator:reset')
  })

  it('exposes the per-conversation Fast preference on dedicated channels', () => {
    api.chatGetFastMode('c1')
    expect(invokeSpy).toHaveBeenCalledWith('chat:get-fast-mode', 'c1')

    api.chatSetFastMode('c1', false)
    expect(invokeSpy).toHaveBeenCalledWith('chat:set-fast-mode', 'c1', false)
  })

  it('exposes the manual ChatGPT Web companion lifecycle on dedicated channels', async () => {
    api.chatGptWebCompanionStart('conv-web')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:companion-start', {
      conversationId: 'conv-web',
    })

    api.chatGptWebCompanionPrompt('conv-web')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:companion-prompt', {
      conversationId: 'conv-web',
    })

    invokeSpy.mockResolvedValueOnce({ ok: true, kickoff: 'safe-prompt' })
    await api.chatGptWebCompanionCopyPrompt('conv-web')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:companion-prompt', {
      conversationId: 'conv-web',
    })
    expect(clipboardWriteSpy).toHaveBeenCalledWith('safe-prompt')

    invokeSpy.mockResolvedValueOnce({ ok: true, sessionKey: 'safe-session-key' })
    await api.chatGptWebCompanionCopySessionKey('conv-web')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:companion-session-key', {
      conversationId: 'conv-web',
    })
    expect(clipboardWriteSpy).toHaveBeenCalledWith('safe-session-key')

    api.chatGptWebCompanionOpen('conv-web')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:companion-open', {
      conversationId: 'conv-web',
    })

    api.chatGptWebCompanionEnd('conv-web')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:companion-end', {
      conversationId: 'conv-web',
    })

    api.chatGptWebBrowserReset()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:chatgpt-web:browser-reset')
  })

  it('exposes the paired review loop contract and its sanitized event', () => {
    api.chatReviewLoopCompatible('executor')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:review-loop:compatible', 'executor')

    const input = {
      executorConversationId: 'executor',
      reviewerConversationId: 'reviewer',
      maxIterations: 5,
      severityThreshold: 'important',
    }
    api.chatReviewLoopStart(input)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:review-loop:start', input)
    api.chatReviewLoopStop('reviewer')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:review-loop:stop', 'reviewer')
    api.chatReviewLoopStatus('executor')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:review-loop:status', 'executor')
    api.chatReviewLoopStatuses()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:review-loop:status')

    const callback = vi.fn()
    const off = api.onChatReviewLoopChanged(callback) as () => void
    const [channel, listener] = onSpy.mock.calls.at(-1) as [string, (...args: unknown[]) => void]
    expect(channel).toBe('chat:review-loop:changed')
    listener({}, [{ loopId: 'loop' }])
    expect(callback).toHaveBeenCalledWith([{ loopId: 'loop' }])
    off()
    expect(removeListenerSpy).toHaveBeenCalledWith(channel, listener)
  })

  it('queries native ChatGPT visibility by conversation', () => {
    api.isChatGptVisible('conv-visible')
    expect(invokeSpy).toHaveBeenLastCalledWith('drawer:chatgpt-visible', 'conv-visible')
  })

  it('subscribes to Companion visual completion on its dedicated channel and removes the listener', () => {
    const callback = vi.fn()
    const off = api.onChatGptWebTurnCompleted(callback) as () => void
    expect(onSpy).toHaveBeenCalledTimes(1)
    const [channel, listener] = onSpy.mock.calls[0] as [string, (...args: unknown[]) => void]
    expect(channel).toBe('chat:chatgpt-web:turn-completed')

    listener({}, { conversationId: 'conv-completed' })
    expect(callback).toHaveBeenCalledWith({ conversationId: 'conv-completed' })

    off()
    expect(removeListenerSpy).toHaveBeenCalledWith(channel, listener)
  })

  it('chatHistoryPage(convId,opts) -> chat:history:page in exact argument order (invoke)', () => {
    api.chatHistoryPage('c1', { beforeSeq: 42, limit: 50 })
    expect(invokeSpy).toHaveBeenCalledWith('chat:history:page', 'c1', { beforeSeq: 42, limit: 50 })
  })
  it('chatHistoryPage(convId) invokes chat:history:page with undefined options', () => {
    api.chatHistoryPage('c1')
    expect(invokeSpy).toHaveBeenCalledWith('chat:history:page', 'c1', undefined)
  })
  it('chatHistoryStats(convId) -> chat:history:stats (invoke)', () => {
    api.chatHistoryStats('c1')
    expect(invokeSpy).toHaveBeenCalledWith('chat:history:stats', 'c1')
  })
  it('child sessions preserve channels, parent identity, and pagination', () => {
    api.chatSubagentSessions('c1', { parentMessageId: 'm1', origin: 'delegate', limit: 20 })
    expect(invokeSpy).toHaveBeenCalledWith('chat:subagents:list', 'c1', {
      parentMessageId: 'm1',
      origin: 'delegate',
      limit: 20,
    })
    api.chatSubagentResolve('c1', 'm1', 'call-1')
    expect(invokeSpy).toHaveBeenCalledWith('chat:subagent:resolve', {
      conversationId: 'c1',
      parentMessageId: 'm1',
      toolCallId: 'call-1',
    })
    api.chatSubagentTranscript('c1', 'subagent-1', { limit: 100 })
    expect(invokeSpy).toHaveBeenCalledWith('chat:subagent:transcript', 'c1', 'subagent-1', { limit: 100 })
  })
  it('chatRuntime(convId) -> chat:runtime (invoke)', () => {
    api.chatRuntime('c1')
    expect(invokeSpy).toHaveBeenCalledWith('chat:runtime', 'c1')
  })
  it('exposes paginated history only, without the legacy chatHistory API', () => {
    expect((api as Record<string, unknown>).chatHistory).toBeUndefined()
  })
  it('chatSearchMessages(convId,query) -> chat:search (invoke) [#559]', () => {
    api.chatSearchMessages('c1', 'term')
    expect(invokeSpy).toHaveBeenCalledWith('chat:search', 'c1', 'term')
  })

  it('skill groups and selections preserve channels and argument order', () => {
    api.chatSkillsState('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:state', 'c1')
    api.chatSkillGroups()
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:groups:list')
    const input = { name: 'Golang Backend', skills: ['go-style'] }
    api.chatSkillGroupCreate(input)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:groups:create', input)
    const patch = { description: 'APIs', skills: ['go-style', 'go-errors'] }
    api.chatSkillGroupUpdate('group-1', patch)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:groups:update', 'group-1', patch)
    api.chatSkillGroupRemove('group-1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:groups:remove', 'group-1')
    const selection = { kind: 'group', groupId: 'group-1' }
    api.chatSkillSetSelection('c1', selection)
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:set-selection', 'c1', selection)
    api.chatSkillResetOverrides('c1')
    expect(invokeSpy).toHaveBeenLastCalledWith('chat:skills:reset-overrides', 'c1')
  })
})

describe('channel cross-check chat:history* / chat:runtime (preload -> src/main/**) [#559]', () => {
  it('chat:history:page, chat:history:stats, chat:search, and chat:runtime are registered in main', () => {
    expect(mainText).toMatch(/\bmhandle\(\s*'chat:history:page'/)
    expect(mainText).toMatch(/\bmhandle\(\s*'chat:history:stats'/)
    expect(mainText).toMatch(/\bmhandle\(\s*'chat:search'/)
    expect(mainText).toMatch(/\bmhandle\(\s*'chat:runtime'/)
  })

  it('preload uses the same channels to complete the renderer-to-main contract', () => {
    expect(preloadText).toContain("ipcRenderer.invoke('chat:history:page'")
    expect(preloadText).toContain("ipcRenderer.invoke('chat:history:stats'")
    expect(preloadText).toContain("ipcRenderer.invoke('chat:search'")
    expect(preloadText).toContain("ipcRenderer.invoke('chat:runtime'")
  })

  it('legacy chat:history is absent from main', () => {
    expect(mainText).not.toMatch(/\bmhandle\(\s*'chat:history'/)
  })
})

// ---------------------------------------------------------------------------
// Global preload/main IPC boundary contract (#625/F2+).
// Moving handlers must preserve literal channels and remove the old registration.
// Match the preload regardless of the handler's main module.
// ---------------------------------------------------------------------------
describe('global preload/main IPC contract (#625/F2+)', () => {
  const mainChannelFiles = collectMainChannelFiles(MAIN_REGISTRATION_RE)
  const mainChannels = new Set(mainChannelFiles.keys())
  const apiChannels = new Set([
    ...collectFirstCapture(preloadText, PRELOAD_API_CHANNEL_RE),
    // Provider subscription authentication uses an exhaustive data-driven channel map.
    // Channel values remain literal even though runtime selects the provider.
    ...collectFirstCapture(
      preloadText,
      /\b(?:status|login|logout):\s*'(chat:[^']+-subscription:(?:status|login|logout))'/g
    ),
  ])

  it('keeps minimum sanity thresholds for the global inventory', () => {
    expect(mainFiles.size).toBeGreaterThan(0)
    // Adjust these thresholds only when legitimately removing many channels.
    expect(mainChannels.size).toBeGreaterThanOrEqual(200)
    expect(apiChannels.size).toBeGreaterThanOrEqual(200)
  })

  it('every literal preload invoke/send channel is registered in main', () => {
    const missing = [...apiChannels].filter((ch) => !mainChannels.has(ch)).sort()
    expect(missing).toEqual([])
  })

  it('every main registration has a preload consumer or a KNOWN_MAIN_ONLY justification', () => {
    const knownMainOnly = new Set(KNOWN_MAIN_ONLY)
    const orphans = [...mainChannelFiles.entries()]
      .filter(([channel]) => !apiChannels.has(channel) && !knownMainOnly.has(channel))
      .map(([channel, files]) => `${channel} (${files.join(', ')})`)
      .sort()

    expect(orphans).toEqual([])
  })

  it('registers each channel at only one location', () => {
    const duplicates = [...mainChannelFiles.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([channel, files]) => `${channel} (${files.join(', ')})`)
      .sort()

    expect(duplicates).toEqual([])
  })

  it('ipcRenderer.invoke and send use only inventoryable literal channels', () => {
    const dynamicCalls = [...preloadText.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*[^'\s][^\n]*/g)]
      .map((m) => m[0].replace(/\s+/g, ' ').trim())
      .filter(
        (snippet) => !/ipcRenderer\.invoke\(SUBSCRIPTION_CHANNELS\[provider\]\.(?:status|login|logout)/.test(snippet)
      )
      .sort()

    expect(dynamicCalls).toEqual([])
  })

  it('main registrations use literal channels except for internal guarded wrapper delegation', () => {
    const nonLiteralRegistrationRe = /(?:ipcMain\.(?:handle|on)|\breg\.(?:handle|on)|\bmhandle|\bmon)\(\s*[^'\s][^\n]*/g
    const allowedGuardDelegationRe = /ipcMain\.(?:handle|on)\(\s*channel,\s*(?:guard(?:Handle|On)\(fn\)|fn)\s*\)/
    const dynamicRegistrations: string[] = []

    for (const [file, text] of mainFiles) {
      for (const match of text.matchAll(nonLiteralRegistrationRe)) {
        const snippet = match[0].replace(/\s+/g, ' ').trim()
        if (!allowedGuardDelegationRe.test(snippet)) {
          dynamicRegistrations.push(`${file}: ${snippet}`)
        }
      }
    }

    expect(dynamicRegistrations.sort()).toEqual([])
  })

  it('every literal preload listener channel is emitted literally in main', () => {
    const listenerChannels = collectFirstCapture(preloadText, PRELOAD_LISTENER_CHANNEL_RE)
    const missingEvents = [...listenerChannels].filter((channel) => !mainText.includes(`'${channel}'`)).sort()

    expect(listenerChannels.size).toBeGreaterThan(0)
    expect(missingEvents).toEqual([])
  })
})
