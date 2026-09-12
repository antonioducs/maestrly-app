import { z } from 'zod'
import {
  acquireBrowserForControl,
  acquireBrowserTabForControl,
  getBrowserState,
  getBrowserStateForScope,
  createBrowserTab,
  closeBrowserTab,
  switchBrowserTab,
  getBrowserTabOwnerScopeId,
  listBrowserTabIdsOwnedByScope,
  closeBrowserWindowsOwnedByScope,
  touchActiveBrowserActivity,
} from '../../drawer-manager'
import * as bc from '../../browser-control'
import type { McpToolContext } from './context'

const SCREENSHOT_METADATA_TIMEOUT_MS = 1_000

function shortBrowserError(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replace(/\s+/g, ' ')
    .slice(0, 180)
}

export function registerBrowserTools(ctx: McpToolContext): void {
  const { server, convId, t, workerScope } = ctx
  if (workerScope && workerScope.conversationId !== convId) {
    throw new Error('Maestro worker scope conversation does not match the browser tool context.')
  }
  const DRAWER_NOTE = t('notes.drawer')
  type BrowserWebContents = ReturnType<typeof acquireBrowserForControl>['webContents']
  type BrowserLease = Pick<ReturnType<typeof acquireBrowserForControl>, 'webContents' | 'captureFrame' | 'release'>
  type BrowserToolTab = ReturnType<typeof getBrowserState>['tabs'][number]
  const scopeStateKey = `browser-scope:${convId}`
  let scopedActiveTabId: string | null = null
  let scopedOwnedTabIds: string[] = []

  const readScopedTabs = (): { tabs: BrowserToolTab[]; activeId: string | null } => {
    if (!workerScope) return { tabs: [], activeId: null }
    const state = getBrowserStateForScope(convId, workerScope.id)
    const liveOwnedIds = new Set(listBrowserTabIdsOwnedByScope(convId, workerScope.id))
    // The state is authoritative for ordering and liveness. This both prunes closed tabs and discovers
    // tabs inherited through window.open from an owned page.
    scopedOwnedTabIds = state.tabs.filter((tab) => liveOwnedIds.has(tab.id)).map((tab) => tab.id)
    if (!scopedActiveTabId || !scopedOwnedTabIds.includes(scopedActiveTabId)) {
      scopedActiveTabId = scopedOwnedTabIds[0] ?? null
    }
    const ownedIds = new Set(scopedOwnedTabIds)
    return { tabs: state.tabs.filter((tab) => ownedIds.has(tab.id)), activeId: scopedActiveTabId }
  }

  const ensureScopedTab = (): { tabs: BrowserToolTab[]; activeId: string } => {
    if (!workerScope) throw new Error('Maestro browser scope is unavailable.')
    let scoped = readScopedTabs()
    if (scoped.activeId) return { tabs: scoped.tabs, activeId: scoped.activeId }

    const state = getBrowserState(convId)
    const cloneUrl = state.tabs.find((tab) => tab.id === state.activeId)?.url || 'about:blank'
    scopedActiveTabId = createBrowserTab(convId, cloneUrl, {
      ownerScopeId: workerScope.id,
      activate: false,
    })
    scoped = readScopedTabs()
    if (!scoped.activeId) throw new Error('Maestro browser tab could not be created.')
    return { tabs: scoped.tabs, activeId: scoped.activeId }
  }

  if (workerScope) {
    workerScope.registerCleanup(`browser:${convId}`, () => {
      closeBrowserWindowsOwnedByScope(convId, workerScope.id)
      for (const tabId of listBrowserTabIdsOwnedByScope(convId, workerScope.id)) {
        if (getBrowserTabOwnerScopeId(convId, tabId) === workerScope.id) closeBrowserTab(convId, tabId)
      }
      scopedOwnedTabIds = []
      scopedActiveTabId = null
    })
  }

  const withBrowserLease = async <T>(operation: (lease: BrowserLease) => Promise<T>): Promise<T> => {
    if (!workerScope) {
      const lease = acquireBrowserForControl(convId)
      try {
        return await operation(lease)
      } finally {
        lease.release()
      }
    }

    const tabId = await workerScope.runExclusive(scopeStateKey, () => ensureScopedTab().activeId)
    return workerScope.runExclusive(`browser-tab:${convId}:${tabId}`, async () => {
      if (getBrowserTabOwnerScopeId(convId, tabId) !== workerScope.id) {
        throw new Error('Drawer browser tab is no longer available.')
      }
      const lease = acquireBrowserTabForControl(convId, tabId)
      try {
        return await operation(lease)
      } finally {
        lease.release()
      }
    })
  }
  const withBrowserActivity = <T>(operation: (browser: BrowserWebContents) => Promise<T>): Promise<T> =>
    withBrowserLease((lease) => operation(lease.webContents))

  server.registerTool(
    'browser_navigate',
    {
      title: t('tools.browser_navigate.title'),
      description: t('tools.browser_navigate.description') + DRAWER_NOTE,
      inputSchema: { url: z.string().describe(t('tools.browser_navigate.params.url')) },
    },
    async ({ url }) => {
      return withBrowserActivity(async (browser) => {
        const r = await bc.navigate(browser, url)
        return { content: [{ type: 'text', text: t('returns.browser.navigated', { url: r.url }) }] }
      })
    }
  )

  for (const [name, dir, titleKey] of [
    ['browser_back', 'back', 'browser_back'],
    ['browser_forward', 'forward', 'browser_forward'],
    ['browser_reload', 'reload', 'browser_reload'],
  ] as const) {
    const label = t(`tools.${titleKey}.title`)
    server.registerTool(
      name,
      {
        title: label,
        description:
          (dir === 'reload' ? t('tools.browser_nav.reloadDesc') : t('tools.browser_nav.moveDesc', { label })) +
          t('tools.browser_nav.descSuffix') +
          DRAWER_NOTE,
        inputSchema: {},
      },
      async () => {
        return withBrowserActivity(async (browser) => {
          const r = await bc.navHistory(browser, dir)
          if (!r.moved && dir !== 'reload')
            return { content: [{ type: 'text', text: t('returns.browser.noHistory', { label: label.toLowerCase() }) }] }
          return {
            content: [
              {
                type: 'text',
                text:
                  dir === 'reload'
                    ? t('returns.browser.reloaded', { url: r.url })
                    : t('returns.browser.moved', { label, url: r.url }),
              },
            ],
          }
        })
      }
    )
  }

  server.registerTool(
    'browser_wait_for',
    {
      title: t('tools.browser_wait_for.title'),
      description: t('tools.browser_wait_for.description') + DRAWER_NOTE,
      inputSchema: {
        selector: z.string().optional().describe(t('tools.browser_wait_for.params.selector')),
        text: z.string().optional().describe(t('tools.browser_wait_for.params.text')),
        network_idle: z.boolean().optional().describe(t('tools.browser_wait_for.params.networkIdle')),
        timeout_ms: z.number().int().positive().optional().describe(t('tools.browser_wait_for.params.timeoutMs')),
      },
    },
    async ({ selector, text, network_idle, timeout_ms }) => {
      return withBrowserActivity(async (browser) => {
        const r = await bc.waitFor(browser, {
          selector,
          text,
          networkIdle: network_idle,
          timeoutMs: timeout_ms,
          ...(workerScope?.signal ? { signal: workerScope.signal } : {}),
        })
        const what = selector
          ? t('returns.browser.waitWhatSelector', { selector })
          : text
            ? t('returns.browser.waitWhatText', { text })
            : network_idle
              ? t('returns.browser.waitWhatNetwork')
              : t('returns.browser.waitWhatNone')
        return {
          content: [
            {
              type: 'text',
              text: r.matched
                ? t('returns.browser.waitOk', { what, ms: r.waitedMs })
                : t('returns.browser.waitTimeout', { what, ms: r.waitedMs }),
            },
          ],
        }
      })
    }
  )

  server.registerTool(
    'browser_snapshot',
    {
      title: t('tools.browser_snapshot.title'),
      description: t('tools.browser_snapshot.description') + DRAWER_NOTE,
      inputSchema: {},
    },
    async () => {
      return withBrowserActivity(async (browser) => {
        const r = await bc.snapshot(browser)
        const pct = r.scroll.maxY > 0 ? Math.round((r.scroll.y / r.scroll.maxY) * 100) : 0
        const head = t('returns.browser.snapshotHead', {
          url: r.url,
          width: r.viewport.width,
          height: r.viewport.height,
          y: r.scroll.y,
          maxY: r.scroll.maxY,
          pct,
          mouseX: r.mouse.x,
          mouseY: r.mouse.y,
        })
        return {
          content: [{ type: 'text', text: `${head}\n${JSON.stringify(r.elements, null, 2)}` }],
        }
      })
    }
  )

  server.registerTool(
    'browser_click',
    {
      title: t('tools.browser_click.title'),
      description: t('tools.browser_click.description'),
      inputSchema: { ref: z.number().int().describe(t('tools.browser_click.params.ref')) },
    },
    async ({ ref }) => {
      return withBrowserActivity(async (browser) => {
        await bc.clickRef(browser, ref)
        return { content: [{ type: 'text', text: t('returns.browser.clicked', { ref }) }] }
      })
    }
  )

  server.registerTool(
    'browser_double_click',
    {
      title: t('tools.browser_double_click.title'),
      description: t('tools.browser_double_click.description'),
      inputSchema: { ref: z.number().int().describe(t('tools.browser_double_click.params.ref')) },
    },
    async ({ ref }) => {
      return withBrowserActivity(async (browser) => {
        await bc.doubleClickRef(browser, ref)
        return { content: [{ type: 'text', text: t('returns.browser.doubleClicked', { ref }) }] }
      })
    }
  )

  server.registerTool(
    'browser_right_click',
    {
      title: t('tools.browser_right_click.title'),
      description: t('tools.browser_right_click.description'),
      inputSchema: { ref: z.number().int().describe(t('tools.browser_right_click.params.ref')) },
    },
    async ({ ref }) => {
      return withBrowserActivity(async (browser) => {
        await bc.rightClickRef(browser, ref)
        return { content: [{ type: 'text', text: t('returns.browser.rightClicked', { ref }) }] }
      })
    }
  )

  server.registerTool(
    'browser_drag',
    {
      title: t('tools.browser_drag.title'),
      description: t('tools.browser_drag.description'),
      inputSchema: {
        from_ref: z.number().int().describe(t('tools.browser_drag.params.fromRef')),
        to_ref: z.number().int().describe(t('tools.browser_drag.params.toRef')),
      },
    },
    async ({ from_ref, to_ref }) => {
      return withBrowserActivity(async (browser) => {
        await bc.dragRef(browser, from_ref, to_ref)
        return { content: [{ type: 'text', text: t('returns.browser.dragged', { from: from_ref, to: to_ref }) }] }
      })
    }
  )

  server.registerTool(
    'browser_type',
    {
      title: t('tools.browser_type.title'),
      description: t('tools.browser_type.description'),
      inputSchema: {
        ref: z.number().int().describe(t('tools.browser_type.params.ref')),
        text: z.string().describe(t('tools.browser_type.params.text')),
        clear: z.boolean().optional().describe(t('tools.browser_type.params.clear')),
      },
    },
    async ({ ref, text, clear }) => {
      return withBrowserActivity(async (browser) => {
        await bc.typeRef(browser, ref, text, clear)
        return {
          content: [
            {
              type: 'text',
              text: clear ? t('returns.browser.clearedTyped', { ref }) : t('returns.browser.typed', { ref }),
            },
          ],
        }
      })
    }
  )

  server.registerTool(
    'browser_press_key',
    {
      title: t('tools.browser_press_key.title'),
      description: t('tools.browser_press_key.description') + DRAWER_NOTE,
      inputSchema: {
        key: z.string().describe(t('tools.browser_press_key.params.key')),
        modifiers: z
          .array(z.enum(['Control', 'Meta', 'Alt', 'Shift']))
          .optional()
          .describe(t('tools.browser_press_key.params.modifiers')),
      },
    },
    async ({ key, modifiers }) => {
      return withBrowserActivity(async (browser) => {
        await bc.pressKey(browser, key, modifiers)
        const combo = modifiers?.length ? `${modifiers.join('+')}+${key}` : key
        return { content: [{ type: 'text', text: t('returns.browser.key', { combo }) }] }
      })
    }
  )

  server.registerTool(
    'browser_read_text',
    {
      title: t('tools.browser_read_text.title'),
      description: t('tools.browser_read_text.description') + DRAWER_NOTE,
      inputSchema: {},
    },
    async () => {
      return withBrowserActivity(async (browser) => {
        const text = await bc.readText(browser)
        return { content: [{ type: 'text', text }] }
      })
    }
  )

  server.registerTool(
    'browser_screenshot',
    {
      title: t('tools.browser_screenshot.title'),
      description: t('tools.browser_screenshot.description') + DRAWER_NOTE,
      inputSchema: {},
    },
    async (_args, extra) => {
      return withBrowserLease(async (acquired) => {
        const browser = acquired.webContents
        const data = await bc.screenshot(browser, {
          signal: extra.signal,
          captureFrame: acquired.captureFrame,
        })
        const m = bc.mousePosition(browser)
        let s: bc.ScrollPosition | null = null
        let scrollError: unknown
        try {
          s = await bc.scrollPosition(browser, {
            signal: extra.signal,
            timeoutMs: SCREENSHOT_METADATA_TIMEOUT_MS,
          })
        } catch (error) {
          if (extra.signal.aborted) throw error
          scrollError = error
        }
        const pct = s && s.maxY > 0 ? Math.round((s.y / s.maxY) * 100) : 0
        return {
          content: [
            { type: 'image', data, mimeType: 'image/png' },
            {
              type: 'text',
              text: s
                ? t('returns.browser.screenshotInfo', { x: m.x, y: m.y, y2: s.y, maxY: s.maxY, pct })
                : t('returns.browser.screenshotInfoUnavailable', {
                    x: m.x,
                    y: m.y,
                    error: shortBrowserError(scrollError),
                  }),
            },
          ],
        }
      })
    }
  )

  server.registerTool(
    'browser_evaluate',
    {
      title: t('tools.browser_evaluate.title'),
      description: t('tools.browser_evaluate.description') + DRAWER_NOTE,
      inputSchema: {
        expression: z.string().describe(t('tools.browser_evaluate.params.expression')),
      },
    },
    async ({ expression }) => {
      return withBrowserActivity(async (browser) => {
        const r = await bc.evaluate(browser, expression)
        return { content: [{ type: 'text', text: r.value }] }
      })
    }
  )

  server.registerTool(
    'browser_mouse_move',
    {
      title: t('tools.browser_mouse_move.title'),
      description: t('tools.browser_mouse_move.description') + DRAWER_NOTE,
      inputSchema: {
        x: z.number().finite().describe(t('tools.browser_mouse_move.params.x')),
        y: z.number().finite().describe(t('tools.browser_mouse_move.params.y')),
      },
    },
    async ({ x, y }) => {
      return withBrowserActivity(async (browser) => {
        const p = await bc.moveMouse(browser, x, y)
        return { content: [{ type: 'text', text: t('returns.browser.mouseMoved', { x: p.x, y: p.y }) }] }
      })
    }
  )

  server.registerTool(
    'browser_scroll',
    {
      title: t('tools.browser_scroll.title'),
      description: t('tools.browser_scroll.description') + DRAWER_NOTE,
      inputSchema: {
        dy: z.number().finite().optional().describe(t('tools.browser_scroll.params.dy')),
        dx: z.number().finite().optional().describe(t('tools.browser_scroll.params.dx')),
        y: z.number().finite().optional().describe(t('tools.browser_scroll.params.y')),
        x: z.number().finite().optional().describe(t('tools.browser_scroll.params.x')),
        to: z.enum(['top', 'bottom']).optional().describe(t('tools.browser_scroll.params.to')),
        selector: z.string().optional().describe(t('tools.browser_scroll.params.selector')),
        container: z.string().optional().describe(t('tools.browser_scroll.params.container')),
      },
    },
    async ({ dx, dy, x, y, to, selector, container }) => {
      return withBrowserActivity(async (browser) => {
        const p = await bc.scroll(browser, { dx, dy, x, y, to, selector, container })
        const pct = p.maxY > 0 ? Math.round((p.y / p.maxY) * 100) : 0
        const onde = container ? t('returns.browser.scrollContainer', { container }) : ''
        return {
          content: [
            {
              type: 'text',
              text: t('returns.browser.scroll', { y: p.y, maxY: p.maxY, pct, x: p.x, maxX: p.maxX, where: onde }),
            },
          ],
        }
      })
    }
  )

  server.registerTool(
    'browser_console_logs',
    {
      title: t('tools.browser_console_logs.title'),
      description: t('tools.browser_console_logs.description') + DRAWER_NOTE,
      inputSchema: {
        level: z
          .enum(['log', 'info', 'warning', 'error', 'debug', 'exception'])
          .optional()
          .describe(t('tools.browser_console_logs.params.level')),
        limit: z.number().int().optional().describe(t('tools.browser_console_logs.params.limit')),
      },
    },
    async ({ level, limit }) => {
      return withBrowserActivity(async (browser) => {
        const logs = await bc.getConsoleLogs(browser, { level, limit })
        const text = logs.length
          ? logs.map((l) => `[${l.level}] ${l.text}`).join('\n')
          : t('returns.browser.noConsoleLogs')
        return { content: [{ type: 'text', text }] }
      })
    }
  )

  server.registerTool(
    'browser_network_logs',
    {
      title: t('tools.browser_network_logs.title'),
      description: t('tools.browser_network_logs.description') + DRAWER_NOTE,
      inputSchema: {
        onlyErrors: z.boolean().optional().describe(t('tools.browser_network_logs.params.onlyErrors')),
        limit: z.number().int().optional().describe(t('tools.browser_network_logs.params.limit')),
      },
    },
    async ({ onlyErrors, limit }) => {
      return withBrowserActivity(async (browser) => {
        const net = await bc.getNetworkLogs(browser, { onlyErrors, limit })
        const text = net.length
          ? net
              .map(
                (n) =>
                  `${n.method} ${n.status ?? (n.failed ? 'FAILED' : '...')} ${n.url}${
                    n.errorText ? ` (${n.errorText})` : ''
                  }`
              )
              .join('\n')
          : t('returns.browser.noNetworkLogs')
        return { content: [{ type: 'text', text }] }
      })
    }
  )

  server.registerTool(
    'browser_clear_logs',
    {
      title: t('tools.browser_clear_logs.title'),
      description: t('tools.browser_clear_logs.description') + DRAWER_NOTE,
      inputSchema: {},
    },
    async () => {
      return withBrowserActivity(async (browser) => {
        await bc.clearLogs(browser)
        return { content: [{ type: 'text', text: t('returns.browser.logsCleared') }] }
      })
    }
  )

  server.registerTool(
    'browser_set_dialog_behavior',
    {
      title: t('tools.browser_set_dialog_behavior.title'),
      description: t('tools.browser_set_dialog_behavior.description') + DRAWER_NOTE,
      inputSchema: {
        accept: z.boolean().describe(t('tools.browser_set_dialog_behavior.params.accept')),
        prompt_text: z.string().optional().describe(t('tools.browser_set_dialog_behavior.params.promptText')),
      },
    },
    async ({ accept, prompt_text }) => {
      return withBrowserActivity(async (browser) => {
        await bc.setDialogBehavior(browser, accept, prompt_text)
        return {
          content: [
            {
              type: 'text',
              text: t('returns.browser.dialogBehavior', {
                action: accept ? t('returns.browser.dialogAccepted') : t('returns.browser.dialogCancelled'),
                prompt: prompt_text ? t('returns.browser.dialogPrompt', { text: prompt_text }) : '',
              }),
            },
          ],
        }
      })
    }
  )

  // Browser tab management uses one-based indices from browser_tabs, resolved to internal IDs through
  // getBrowserState. Other browser tools operate on the active tab through acquireBrowserForControl.
  server.registerTool(
    'browser_tabs',
    {
      title: t('tools.browser_tabs.title'),
      description: t('tools.browser_tabs.description') + DRAWER_NOTE,
      inputSchema: {},
    },
    async () => {
      const scoped = workerScope
        ? await workerScope.runExclusive(scopeStateKey, ensureScopedTab)
        : (() => {
            touchActiveBrowserActivity(convId)
            const state = getBrowserState(convId)
            return { tabs: state.tabs, activeId: state.activeId }
          })()
      if (scoped.tabs.length === 0) return { content: [{ type: 'text', text: t('returns.browser.noTabs') }] }
      const text = scoped.tabs
        .map((tab, i) =>
          t('returns.browser.tabRow', {
            index: i + 1,
            active: tab.id === scoped.activeId ? t('returns.browser.tabRowActive') : '',
            title: tab.title || t('returns.browser.tabRowNewTitle'),
            url: tab.url || 'about:blank',
          })
        )
        .join('\n')
      return { content: [{ type: 'text', text }] }
    }
  )

  server.registerTool(
    'browser_switch_tab',
    {
      title: t('tools.browser_switch_tab.title'),
      description: t('tools.browser_switch_tab.description') + DRAWER_NOTE,
      inputSchema: {
        index: z.number().int().positive().describe(t('tools.browser_switch_tab.params.index')),
      },
    },
    async ({ index }) => {
      if (workerScope) {
        const scoped = await workerScope.runExclusive(scopeStateKey, () => {
          const current = ensureScopedTab()
          const tab = current.tabs[index - 1]
          if (tab) scopedActiveTabId = tab.id
          return { ...current, tab }
        })
        if (!scoped.tab) {
          return {
            content: [{ type: 'text', text: t('errors.tabNotExist', { index, total: scoped.tabs.length }) }],
            isError: true,
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: t('returns.browser.tabActive', {
                index,
                label: scoped.tab.title || scoped.tab.url,
              }),
            },
          ],
        }
      }

      const st = getBrowserState(convId)
      const tab = st.tabs[index - 1]
      if (!tab)
        return {
          content: [{ type: 'text', text: t('errors.tabNotExist', { index, total: st.tabs.length }) }],
          isError: true,
        }
      switchBrowserTab(convId, tab.id)
      touchActiveBrowserActivity(convId)
      return {
        content: [{ type: 'text', text: t('returns.browser.tabActive', { index, label: tab.title || tab.url }) }],
      }
    }
  )

  server.registerTool(
    'browser_new_tab',
    {
      title: t('tools.browser_new_tab.title'),
      description: t('tools.browser_new_tab.description') + DRAWER_NOTE,
      inputSchema: {
        url: z.string().optional().describe(t('tools.browser_new_tab.params.url')),
      },
    },
    async ({ url }) => {
      if (workerScope) {
        const opened = await workerScope.runExclusive(scopeStateKey, () => {
          ensureScopedTab()
          const tabId = createBrowserTab(convId, url, {
            ownerScopeId: workerScope.id,
            activate: false,
          })
          scopedActiveTabId = tabId
          const current = readScopedTabs()
          return {
            index: current.tabs.findIndex((tab) => tab.id === tabId) + 1,
            total: current.tabs.length,
          }
        })
        return {
          content: [
            {
              type: 'text',
              text: t('returns.browser.tabOpened', { index: opened.index, total: opened.total }),
            },
          ],
        }
      }

      createBrowserTab(convId, url)
      touchActiveBrowserActivity(convId)
      const st = getBrowserState(convId)
      return {
        content: [
          { type: 'text', text: t('returns.browser.tabOpened', { index: st.tabs.length, total: st.tabs.length }) },
        ],
      }
    }
  )

  server.registerTool(
    'browser_close_tab',
    {
      title: t('tools.browser_close_tab.title'),
      description: t('tools.browser_close_tab.description') + DRAWER_NOTE,
      inputSchema: {
        index: z.number().int().positive().describe(t('tools.browser_close_tab.params.index')),
      },
    },
    async ({ index }) => {
      if (workerScope) {
        const selected = await workerScope.runExclusive(scopeStateKey, () => {
          const current = ensureScopedTab()
          return { tab: current.tabs[index - 1], total: current.tabs.length }
        })
        if (!selected.tab) {
          return {
            content: [{ type: 'text', text: t('errors.tabNotExist', { index, total: selected.total }) }],
            isError: true,
          }
        }

        const closed = await workerScope.runExclusive(`browser-tab:${convId}:${selected.tab.id}`, () => {
          if (getBrowserTabOwnerScopeId(convId, selected.tab!.id) !== workerScope.id) return false
          closeBrowserTab(convId, selected.tab!.id)
          return true
        })
        if (!closed) {
          const total = await workerScope.runExclusive(scopeStateKey, () => readScopedTabs().tabs.length)
          return {
            content: [{ type: 'text', text: t('errors.tabNotExist', { index, total }) }],
            isError: true,
          }
        }
        await workerScope.runExclusive(scopeStateKey, () => {
          const current = readScopedTabs()
          if (scopedActiveTabId === selected.tab!.id) {
            scopedActiveTabId = current.tabs[index - 1]?.id ?? current.tabs[index - 2]?.id ?? null
          }
        })
        return { content: [{ type: 'text', text: t('returns.browser.tabClosed', { index }) }] }
      }

      const st = getBrowserState(convId)
      const tab = st.tabs[index - 1]
      if (!tab)
        return {
          content: [{ type: 'text', text: t('errors.tabNotExist', { index, total: st.tabs.length }) }],
          isError: true,
        }
      closeBrowserTab(convId, tab.id)
      touchActiveBrowserActivity(convId)
      return { content: [{ type: 'text', text: t('returns.browser.tabClosed', { index }) }] }
    }
  )
}
