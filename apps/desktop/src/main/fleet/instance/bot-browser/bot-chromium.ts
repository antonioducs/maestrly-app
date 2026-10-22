import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizeBrowserInput } from '../../../../shared/browser-omnibox'
import type { CdpEvent, CdpPipe } from './cdp-pipe'
import { ChromiumPage, type ChromiumTargetInfo } from './chromium-page'
import { ChromiumSupervisor, type ChromiumSupervisorDeps } from './chromium-supervisor'
import { importSharedCookies, type SharedCookie } from './cookie-import'

/** How long a bot's Chromium stays open without its tools or anyone watching its screen. */
export const BOT_CHROMIUM_IDLE_MS = 15 * 60_000
const IDLE_CHECK_MS = 60_000
const SAVE_DELAY_MS = 500
/** Left in the profile once the shared site logins were copied into it, so they are copied only once. */
export const COOKIES_IMPORTED_MARKER = '.maestrly-shared-cookies-imported'
const DEFAULT_TAB_URL = 'https://www.google.com'

export interface BotChromiumTab {
  id: string
  title: string
  url: string
}

export interface BotChromiumState {
  tabs: BotChromiumTab[]
  activeId: string | null
}

interface TabOwner {
  conversationId: string
  /** The delegated worker whose tab it is; none for the conversation's own tabs. */
  scopeId?: string
}

interface TabRecord {
  info: ChromiumTargetInfo
  owner?: TabOwner
  page?: ChromiumPage
  attaching?: Promise<ChromiumPage>
}

interface SavedTab {
  url: string
  conversationId: string
  active?: boolean
}

export interface BotChromiumFs {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string): Promise<void>
  exists(file: string): Promise<boolean>
}

export interface BotChromiumOptions {
  botId: string
  deps: ChromiumSupervisorDeps & { setInterval: typeof setInterval; clearInterval: typeof clearInterval }
  /** The variables of the bot's programs: its display, bus and profile. Null while it has no display. */
  env(): Record<string, string> | null
  /** Runs before each start of the browser: stops one left holding the profile. */
  beforeStart?(): Promise<void>
  /** The bot's Chromium profile (`MAESTRLY_BOT_BROWSER_PROFILE`), which holds the cookie marker. */
  profile: string
  /** Where the tabs to reopen are kept, beside the profile, so a move takes them along. */
  savedTabsFile: string
  /** Where downloads go, without a dialog. */
  downloads: string
  /** The conversation the bot's desktop shows: tabs a person opens by hand are its. */
  foregroundConversationId(): string | null
  ownsConversation(conversationId: string): boolean
  /** Whether someone watches or controls the bot's screen: its browser never closes while they do. */
  watched(): boolean
  /** The environment's shared site logins, copied into the profile on its first start. */
  sharedCookies?(): Promise<SharedCookie[]>
  idleMs?: number
  fs?: BotChromiumFs
}

const nodeFs: BotChromiumFs = {
  readFile: (file) => fs.readFile(file, 'utf8'),
  writeFile: async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, data, { mode: 0o600 })
    await fs.rename(temporary, file)
  },
  exists: (file) =>
    fs.access(file).then(
      () => true,
      () => false
    ),
}

/**
 * One bot's own Chromium: a real browser on the bot's apps display, with the bot's own profile, driven by the
 * `browser_*` tools through its DevTools pipe. It starts when a tool, a link or the dock needs it and closes after
 * fifteen idle minutes; its tabs are reopened on the next start, and after a crash.
 *
 * Every tab belongs to a conversation of the bot: the one whose tool or link opened it, the opener's for a popup, and
 * the conversation the desktop shows for a tab a person opened. A delegated worker's tabs are its own too. A
 * conversation's tools only see its own tabs.
 */
export class BotChromium {
  private readonly supervisor: ChromiumSupervisor
  private readonly files: BotChromiumFs
  private readonly idleMs: number
  private readonly records = new Map<string, TabRecord>()
  private readonly sessions = new Map<string, ChromiumPage>()
  private readonly active = new Map<string, string>()
  private pipe: CdpPipe | null = null
  private stopEvents: (() => void) | null = null
  /** Tabs being created: a new tab whose owner is not known yet may be one of them. */
  private creating = 0
  /** While it restores tabs or shuts down, closing tabs are not what the person or the bot closed. */
  private quiet = false
  private lastUsed: number
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: BotChromiumOptions) {
    this.files = options.fs ?? nodeFs
    this.idleMs = options.idleMs ?? BOT_CHROMIUM_IDLE_MS
    this.lastUsed = options.deps.now()
    this.supervisor = new ChromiumSupervisor(options.deps, {
      botId: options.botId,
      env: options.env,
      ...(options.beforeStart ? { beforeStart: options.beforeStart } : {}),
      onStarted: (pipe) => this.started(pipe),
      onExited: () => this.exited(),
    })
  }

  get isRunning(): boolean {
    return this.supervisor.isRunning
  }

  /** Marks the browser in use, so it does not close for idleness. */
  touch(): void {
    this.lastUsed = this.options.deps.now()
  }

  /** The conversation's tabs (or a delegated worker's), starting the browser first. */
  async state(conversationId: string, scopeId?: string): Promise<BotChromiumState> {
    await this.ready()
    const tabs = this.owned(conversationId, scopeId).map((id) => this.describe(id))
    return { tabs, activeId: scopeId ? (tabs[0]?.id ?? null) : this.activeOf(conversationId) }
  }

  /** The page of a tab of the conversation, or of its active tab, which is created when it has none. */
  async page(conversationId: string, tabId?: string): Promise<ChromiumPage> {
    await this.ready()
    let id = tabId ?? this.activeOf(conversationId)
    if (!id && tabId === undefined) {
      id = this.claimBlank(conversationId) ?? (await this.createTab(conversationId, DEFAULT_TAB_URL))
      this.active.set(conversationId, id)
    }
    const record = id ? this.records.get(id) : undefined
    if (!id || !record || record.owner?.conversationId !== conversationId)
      throw new Error('This tab of the bot’s Chromium is no longer open.')
    return this.attach(id, record)
  }

  /** Opens a tab for the conversation (or one of its delegated workers); it comes forward unless `activate` is false. */
  async createTab(
    conversationId: string,
    url: string | undefined,
    options: { ownerScopeId?: string; activate?: boolean } = {}
  ): Promise<string> {
    const pipe = await this.ready()
    const activate = options.activate ?? true
    this.creating++
    try {
      const target = url ? normalizeBrowserInput(url) : DEFAULT_TAB_URL
      const { targetId } = (await pipe.send('Target.createTarget', { url: target, background: !activate })) as {
        targetId: string
      }
      const record = this.records.get(targetId) ?? this.add({ targetId, url: target, title: '' })
      record.owner = { conversationId, ...(options.ownerScopeId ? { scopeId: options.ownerScopeId } : {}) }
      if (activate && !options.ownerScopeId) this.active.set(conversationId, targetId)
      this.scheduleSave()
      return targetId
    } finally {
      this.creating--
    }
  }

  /** Makes a tab the conversation's active one and brings it forward in its window. */
  async switchTab(conversationId: string, tabId: string): Promise<void> {
    const pipe = await this.ready()
    if (this.records.get(tabId)?.owner?.conversationId !== conversationId) return
    this.active.set(conversationId, tabId)
    this.scheduleSave()
    await pipe.send('Target.activateTarget', { targetId: tabId }).catch(() => {
      /* The tab closed meanwhile. */
    })
  }

  async closeTab(conversationId: string, tabId: string): Promise<void> {
    const pipe = await this.ready()
    const record = this.records.get(tabId)
    if (record?.owner?.conversationId !== conversationId) return
    // As in the drawer, the conversation's next tab, or the one before, becomes active.
    const index = this.owned(conversationId).indexOf(tabId)
    this.remove(tabId)
    if (this.active.get(conversationId) === tabId) {
      const rest = this.owned(conversationId)
      const next = rest[index] ?? rest[index - 1]
      if (next) this.active.set(conversationId, next)
      else this.active.delete(conversationId)
    }
    this.scheduleSave()
    await pipe.send('Target.closeTarget', { targetId: tabId }).catch(() => {
      /* Already closed. */
    })
  }

  /** The delegated worker a tab belongs to; read without starting the browser. */
  ownerScopeOf(conversationId: string, tabId: string): string | undefined {
    const owner = this.records.get(tabId)?.owner
    return owner?.conversationId === conversationId ? owner.scopeId : undefined
  }

  tabIdsOwnedByScope(conversationId: string, scopeId: string): string[] {
    return this.owned(conversationId, scopeId)
  }

  /** Brings the conversation's active tab forward while the browser runs; never starts it. */
  present(conversationId: string): void {
    const id = this.isRunning ? this.activeOf(conversationId) : null
    if (id) void this.pipe?.send('Target.activateTarget', { targetId: id }).catch(() => {})
  }

  /** Shows the browser (the dock's launcher): starts it, then brings the conversation's active tab forward. */
  async show(conversationId: string): Promise<void> {
    const page = await this.page(conversationId)
    await this.pipe?.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {})
  }

  /** Opens a link of the bot's programs in a new tab of the conversation, brought forward. */
  async openUrl(conversationId: string, url: string): Promise<void> {
    await this.createTab(conversationId, url)
  }

  /** Closes every tab of a conversation that ended, its workers' too; a browser that is not running stays stopped. */
  async closeConversation(conversationId: string): Promise<void> {
    const ids = [...this.records.entries()]
      .filter(([, record]) => record.owner?.conversationId === conversationId)
      .map(([id]) => id)
    this.active.delete(conversationId)
    for (const id of ids) this.remove(id)
    const pipe = this.isRunning ? this.pipe : null
    if (!pipe) {
      // Its saved tabs must not come back on the next start.
      this.saving = this.saving
        .then(async () => {
          const saved = await this.readSaved()
          const kept = saved.filter((tab) => tab.conversationId !== conversationId)
          if (kept.length !== saved.length) await this.writeTabs(kept)
        })
        .catch((error: unknown) => this.log(`could not save its tabs: ${(error as Error).message}`))
      await this.saving
      return
    }
    if (ids.length > 0) this.scheduleSave()
    for (const id of ids) await pipe.send('Target.closeTarget', { targetId: id }).catch(() => {})
  }

  /** Closes the browser, keeping its tabs to reopen; the next use starts it again. */
  async stop(): Promise<void> {
    await this.shutdown()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.shutdown()
    await this.supervisor.dispose()
  }

  private async ready(): Promise<CdpPipe> {
    if (this.disposed) throw new Error('The bot’s Chromium was stopped for good.')
    this.touch()
    const pipe = await this.supervisor.ensure()
    this.touch()
    return pipe
  }

  private async started(pipe: CdpPipe): Promise<void> {
    this.pipe = pipe
    this.stopEvents?.()
    this.stopEvents = pipe.onEvent((event) => this.onEvent(event))
    await pipe.send('Target.setDiscoverTargets', { discover: true })
    await pipe
      .send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.options.downloads,
        eventsEnabled: false,
      })
      .catch((error: unknown) => this.log(`downloads keep Chromium's default folder: ${(error as Error).message}`))
    await this.importCookiesOnce(pipe)
    await this.restoreTabs(pipe)
    this.startIdleTimer()
  }

  private exited(): void {
    this.stopIdleTimer()
    this.flushSave()
    this.stopEvents?.()
    this.stopEvents = null
    this.pipe = null
    for (const id of [...this.records.keys()]) this.remove(id, 'the bot’s Chromium exited')
    this.active.clear()
  }

  private async shutdown(): Promise<void> {
    if (!this.isRunning) {
      await this.supervisor.stop()
      return
    }
    this.flushSave()
    await this.saving
    this.quiet = true
    try {
      await this.supervisor.stop()
    } finally {
      this.quiet = false
    }
  }

  private onEvent(event: CdpEvent): void {
    if (event.sessionId) {
      this.sessions.get(event.sessionId)?.handleEvent(event)
      return
    }
    const params = event.params as { targetInfo?: Record<string, unknown>; targetId?: string; sessionId?: string }
    switch (event.method) {
      case 'Target.targetCreated': {
        const info = pageInfo(params.targetInfo)
        if (!info || this.records.has(info.targetId)) return
        const record = this.add(info)
        const opener = info.openerId ? this.records.get(info.openerId)?.owner : undefined
        if (opener) record.owner = { ...opener }
        this.scheduleSave()
        return
      }
      case 'Target.targetInfoChanged': {
        const info = pageInfo(params.targetInfo)
        const record = info ? this.records.get(info.targetId) : undefined
        if (!info || !record) return
        record.info = { ...record.info, url: info.url, title: info.title }
        record.page?.updateInfo(info)
        this.scheduleSave()
        return
      }
      case 'Target.targetDestroyed': {
        const id = typeof params.targetId === 'string' ? params.targetId : null
        if (!id || !this.records.has(id)) return
        const owner = this.records.get(id)?.owner
        this.remove(id)
        if (owner && this.active.get(owner.conversationId) === id) this.active.delete(owner.conversationId)
        if (!this.quiet) this.scheduleSave()
        return
      }
      case 'Target.detachedFromTarget': {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
        const page = sessionId ? this.sessions.get(sessionId) : undefined
        if (!page || !sessionId) return
        this.sessions.delete(sessionId)
        const record = this.records.get(page.targetId)
        if (record?.page === page) record.page = undefined
        page.markDestroyed('the session ended')
        return
      }
    }
  }

  private add(info: ChromiumTargetInfo): TabRecord {
    const record: TabRecord = { info }
    this.records.set(info.targetId, record)
    return record
  }

  private remove(id: string, reason = 'target closed'): void {
    const record = this.records.get(id)
    if (!record) return
    this.records.delete(id)
    if (record.page) {
      this.sessions.delete(record.page.sessionId)
      record.page.markDestroyed(reason)
    }
  }

  private describe(id: string): BotChromiumTab {
    const { info } = this.records.get(id)!
    return { id, title: info.title, url: info.url }
  }

  /** The conversation's tabs (a worker's with `scopeId`), oldest first; a person's own tabs join the foreground's. */
  private owned(conversationId: string, scopeId?: string): string[] {
    this.adoptLooseTabs()
    const ids: string[] = []
    for (const [id, record] of this.records) {
      const owner = record.owner
      if (owner?.conversationId === conversationId && (scopeId ? owner.scopeId === scopeId : !owner.scopeId))
        ids.push(id)
    }
    return ids
  }

  private activeOf(conversationId: string): string | null {
    const tabs = this.owned(conversationId)
    const current = this.active.get(conversationId)
    if (current && tabs.includes(current)) return current
    const fallback = tabs.at(-1) ?? null
    if (fallback) this.active.set(conversationId, fallback)
    else this.active.delete(conversationId)
    return fallback
  }

  /** Tabs nobody opened through Maestrly: a person's, opened in the window, belong to the conversation shown. */
  private adoptLooseTabs(): void {
    if (this.creating > 0) return
    const foreground = this.options.foregroundConversationId()
    if (!foreground) return
    for (const record of this.records.values()) if (!record.owner) record.owner = { conversationId: foreground }
  }

  /** The empty tab a new browser opens with, given to the first conversation that needs one. */
  private claimBlank(conversationId: string): string | null {
    for (const [id, record] of this.records) {
      if (record.info.url !== 'about:blank') continue
      if (record.owner && (record.owner.conversationId !== conversationId || record.owner.scopeId)) continue
      record.owner = { conversationId }
      return id
    }
    return null
  }

  private attach(id: string, record: TabRecord): Promise<ChromiumPage> {
    if (record.page && !record.page.isDestroyed()) return Promise.resolve(record.page)
    const pipe = this.pipe
    if (!pipe) return Promise.reject(new Error('The bot’s Chromium is not running.'))
    record.attaching ??= pipe
      .send('Target.attachToTarget', { targetId: id, flatten: true })
      .then(({ sessionId }: { sessionId: string }) => {
        const page = new ChromiumPage(pipe, id, sessionId, record.info)
        if (this.records.get(id) !== record) {
          page.markDestroyed()
          throw new Error('This tab of the bot’s Chromium closed.')
        }
        this.sessions.set(sessionId, page)
        record.page = page
        return page
      })
      .finally(() => {
        record.attaching = undefined
      })
    return record.attaching
  }

  private async importCookiesOnce(pipe: CdpPipe): Promise<void> {
    const read = this.options.sharedCookies
    if (!read) return
    const marker = path.join(this.options.profile, COOKIES_IMPORTED_MARKER)
    if (await this.files.exists(marker)) return
    try {
      const { imported, failed } = await importSharedCookies(pipe, await read())
      this.log(`copied ${imported} shared site cookies into its profile${failed ? ` (${failed} refused)` : ''}.`)
    } catch (error) {
      this.log(`could not copy the shared site cookies: ${(error as Error).message}`)
    }
    // Written even after a failure: copying again later would overwrite the logins made in this browser since.
    await this.files
      .writeFile(marker, `${new Date(this.options.deps.now()).toISOString()}\n`)
      .catch((error: unknown) => this.log(`could not mark the cookies as copied: ${(error as Error).message}`))
  }

  private async restoreTabs(pipe: CdpPipe): Promise<void> {
    const saved = await this.readSaved()
    if (saved.length === 0) return
    const blank = [...this.records.entries()].filter(([, record]) => !record.owner && record.info.url === 'about:blank')
    this.quiet = true
    this.creating++
    try {
      for (const tab of saved) {
        try {
          const { targetId } = (await pipe.send('Target.createTarget', { url: tab.url, background: true })) as {
            targetId: string
          }
          const record = this.records.get(targetId) ?? this.add({ targetId, url: tab.url, title: '' })
          record.owner = { conversationId: tab.conversationId }
          if (tab.active) this.active.set(tab.conversationId, targetId)
        } catch (error) {
          this.log(`could not reopen ${tab.url}: ${(error as Error).message}`)
        }
      }
      for (const [id] of blank) {
        this.remove(id)
        await pipe.send('Target.closeTarget', { targetId: id }).catch(() => {})
      }
    } finally {
      this.creating--
      this.quiet = false
    }
    const foreground = this.options.foregroundConversationId()
    const shown = foreground ? this.activeOf(foreground) : null
    if (shown) await pipe.send('Target.activateTarget', { targetId: shown }).catch(() => {})
    this.scheduleSave()
  }

  private async readSaved(): Promise<SavedTab[]> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.files.readFile(this.options.savedTabsFile))
    } catch {
      return []
    }
    const tabs = (parsed as { tabs?: unknown })?.tabs
    if (!Array.isArray(tabs)) return []
    return tabs.flatMap((tab): SavedTab[] => {
      const { url, conversationId, active } = (tab ?? {}) as Record<string, unknown>
      if (typeof url !== 'string' || typeof conversationId !== 'string' || !/^(https?|file):/i.test(url)) return []
      if (!this.options.ownsConversation(conversationId)) return []
      return [{ url, conversationId, ...(active === true ? { active: true } : {}) }]
    })
  }

  /** The tabs to reopen: the conversations' own, not the workers' (they end with their task) nor empty ones. */
  private savedTabs(): SavedTab[] {
    this.adoptLooseTabs()
    const tabs: SavedTab[] = []
    for (const [id, record] of this.records) {
      const owner = record.owner
      if (!owner || owner.scopeId || !/^(https?|file):/i.test(record.info.url)) continue
      tabs.push({
        url: record.info.url,
        conversationId: owner.conversationId,
        ...(this.active.get(owner.conversationId) === id ? { active: true } : {}),
      })
    }
    return tabs
  }

  private scheduleSave(): void {
    if (this.quiet || this.saveTimer || this.disposed) return
    this.saveTimer = this.options.deps.setTimeout(() => {
      this.saveTimer = null
      this.writeSaved()
    }, SAVE_DELAY_MS)
  }

  private flushSave(): void {
    if (!this.saveTimer) return
    this.options.deps.clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.writeSaved()
  }

  private writeSaved(): void {
    const tabs = this.savedTabs()
    this.saving = this.saving
      .then(() => this.writeTabs(tabs))
      .catch((error: unknown) => this.log(`could not save its tabs: ${(error as Error).message}`))
  }

  private writeTabs(tabs: SavedTab[]): Promise<void> {
    return this.files.writeFile(this.options.savedTabsFile, `${JSON.stringify({ version: 1, tabs })}\n`)
  }

  private startIdleTimer(): void {
    this.stopIdleTimer()
    this.idleTimer = this.options.deps.setInterval(() => {
      if (!this.isRunning) return
      // Someone watching the bot's screen may be using the browser: the idle time starts once they leave.
      if (this.options.watched()) {
        this.touch()
        return
      }
      if (this.options.deps.now() - this.lastUsed < this.idleMs) return
      this.log('closes after its idle time; its tabs reopen on the next use.')
      void this.shutdown().catch(() => {})
    }, IDLE_CHECK_MS)
    ;(this.idleTimer as { unref?: () => void }).unref?.()
  }

  private stopIdleTimer(): void {
    if (!this.idleTimer) return
    this.options.deps.clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  private log(message: string): void {
    this.options.deps.log(`The Chromium of bot ${this.options.botId} ${message}`)
  }
}

function pageInfo(value: Record<string, unknown> | undefined): ChromiumTargetInfo | null {
  if (!value || value.type !== 'page' || typeof value.targetId !== 'string') return null
  const url = typeof value.url === 'string' ? value.url : ''
  if (url.startsWith('devtools://')) return null
  return {
    targetId: value.targetId,
    url,
    title: typeof value.title === 'string' ? value.title : '',
    ...(typeof value.openerId === 'string' && value.openerId ? { openerId: value.openerId } : {}),
  }
}
