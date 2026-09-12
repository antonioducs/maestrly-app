import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { toolOutputImages, toolOutputText, type ChatMode } from '../shared/chat'
import { isChatMode } from '../shared/chat-mode'
import { buildAppTools } from './chat/mcp'
import {
  modelOutputToChatToolOutput,
  resolveEphemeralToolImage,
  toolOutputIsError,
} from './chat/tool-output'
import { isE2E } from './test-mode'
import { drawers } from './drawer/state'

export interface E2EAppToolCallInput {
  conversationId: string
  /** Explicit catalog mode for policy E2Es. Existing tests intentionally default to Agent. */
  mode?: ChatMode
  name: string
  arguments?: Record<string, unknown>
}

export interface E2EAppToolCallResult {
  text: string
  isError: boolean
  images: Array<{ data: string; mediaType: string; byteSize: number }>
}

export interface E2EBrowserViewState {
  bounds: { x: number; y: number; width: number; height: number }
  ownerCount: number
  ownerVisible: boolean
  childIndex: number
}

interface ExecutableTool {
  execute?: (
    input: unknown,
    options: { toolCallId: string; messages: []; abortSignal: AbortSignal },
  ) => Promise<unknown> | unknown
}

declare global {
  // Playwright's ElectronApplication.evaluate executes in this main-process global. The bridge is
  // installed only under AGENTS_E2E=1 and never exists in production.
  // eslint-disable-next-line no-var
  var __maestrlyE2ECallAppTool:
    | ((input: E2EAppToolCallInput) => Promise<E2EAppToolCallResult>)
    | undefined
  // eslint-disable-next-line no-var
  var __maestrlyE2EInspectBrowserView:
    | ((conversationId: string) => E2EBrowserViewState)
    | undefined
}

export function installE2EAppToolsBridge(): void {
  if (!isE2E()) return
  globalThis.__maestrlyE2EInspectBrowserView = (conversationId) => {
    const drawer = drawers.get(conversationId)
    const tab = drawer?.browserTabs.find((candidate) => candidate.id === drawer.activeBrowserId)
    const view = tab?.view
    if (!view) throw new Error(`E2E browser view is unavailable: ${conversationId}`)
    const owners = BrowserWindow.getAllWindows().filter((window) => window.contentView.children.includes(view))
    const owner = owners[0]
    return {
      bounds: view.getBounds(),
      ownerCount: owners.length,
      ownerVisible: owner?.isVisible() ?? false,
      childIndex: owner?.contentView.children.indexOf(view) ?? -1,
    }
  }
  globalThis.__maestrlyE2ECallAppTool = async (input) => {
    if (input.mode !== undefined && !isChatMode(input.mode)) {
      throw new Error(`Invalid E2E app-tool mode: ${String(input.mode)}`)
    }
    const appTools = await buildAppTools({
      conversationId: input.conversationId,
      mode: input.mode ?? 'agent',
      gate: async () => {},
      supportsImages: true,
      describeImage: async () => {
        throw new Error('Vision-capable E2E app tools must not invoke the image interpreter.')
      },
    })
    try {
      const selected = appTools.tools[input.name] as ExecutableTool | undefined
      if (!selected?.execute) throw new Error(`E2E app tool is unavailable: ${input.name}`)
      const output = await selected.execute(input.arguments ?? {}, {
        toolCallId: `e2e-${input.name}-${randomUUID()}`,
        messages: [],
        abortSignal: new AbortController().signal,
      })
      const normalized = modelOutputToChatToolOutput(output)
      return {
        text: toolOutputText(normalized),
        isError: toolOutputIsError(normalized),
        images: toolOutputImages(normalized).map((image) => {
          const resolved = resolveEphemeralToolImage(image)
          if (!resolved) throw new Error(`E2E tool image is unavailable: ${image.id}`)
          return {
            data: resolved.data,
            mediaType: resolved.mediaType,
            byteSize: resolved.byteSize,
          }
        }),
      }
    } finally {
      await appTools.close()
    }
  }
}
