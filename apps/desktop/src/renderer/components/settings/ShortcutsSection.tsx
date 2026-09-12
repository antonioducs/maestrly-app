import { AlertTriangle, Keyboard, X } from 'lucide-react'
import type { ShortcutOpenMode } from '../../../preload'
import { FLOAT_TABS, type FloatTab } from '../../../shared/tool-tabs'
import {
  formatAccelerator,
  bindingKey,
  conflictingTabs,
  type ShortcutMod,
  type ShortcutOs,
  type ShortcutBinding,
  type EffectiveShortcuts,
} from '../../../shared/shortcuts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'

const MOD_SYM: Record<ShortcutMod, { mac: string; pc: string }> = {
  meta: { mac: '⌘', pc: 'Win' },
  control: { mac: '⌃', pc: 'Ctrl' },
  alt: { mac: '⌥', pc: 'Alt' },
  shift: { mac: '⇧', pc: 'Shift' },
}

const MOD_ORDER_BY_OS: Record<'mac' | 'pc', ShortcutMod[]> = {
  mac: ['meta', 'control', 'alt', 'shift'],
  pc: ['control', 'alt', 'meta', 'shift'],
}

const TOOL_LABEL_KEY: Record<FloatTab, string> = {
  browser: 'drawer.tabBrowser',
  vscode: 'drawer.tabCode',
  terminal: 'drawer.tabTerminal',
  plan: 'drawer.tabPlan',
  review: 'drawer.tabReview',
  notes: 'drawer.tabNotes',
  chatgpt: 'drawer.tabChatGpt',
}

export function ShortcutsSection({
  t,
  shortcuts,
  shortcutsOs,
  closeShortcut,
  drawerShortcut,
  openMode,
  recording,
  setRecording,
  setOpenModeState,
  setCloseShortcutState,
  disableShortcut,
  resetShortcuts,
  chatGptWebEnabled,
}: {
  t: TFn
  shortcuts: EffectiveShortcuts
  shortcutsOs: ShortcutOs
  closeShortcut: ShortcutBinding | null
  drawerShortcut: ShortcutBinding | null
  openMode: ShortcutOpenMode
  recording: FloatTab | 'drawer' | null
  setRecording: (tab: FloatTab | 'drawer' | null) => void
  setOpenModeState: (m: ShortcutOpenMode) => void
  setCloseShortcutState: (b: ShortcutBinding) => void
  disableShortcut: (tab: FloatTab) => void
  resetShortcuts: () => void
  chatGptWebEnabled: boolean
}) {
  const visibleTabs = chatGptWebEnabled ? FLOAT_TABS : FLOAT_TABS.filter((tab) => tab !== 'chatgpt')
  const conflicts = conflictingTabs(chatGptWebEnabled ? shortcuts : { ...shortcuts, chatgpt: null })
  const drawerConflictTabs = drawerShortcut
    ? visibleTabs.filter((tab) => shortcuts[tab] && bindingKey(shortcuts[tab]!) === bindingKey(drawerShortcut))
    : []
  for (const tab of drawerConflictTabs) conflicts.add(tab)
  const drawerInConflict = drawerConflictTabs.length > 0
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <div>
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Keyboard className="size-4 text-muted-foreground" /> {t('settings.shortcuts.heading')}
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.shortcuts.desc')}</p>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2">
        <span className="shrink-0 text-[13px] text-foreground">{t('settings.shortcuts.openMode')}</span>
        <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border">
          {(['popup', 'floating'] as ShortcutOpenMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                if (m === openMode) return
                setOpenModeState(m)
                window.api.setShortcutOpenMode(m)
              }}
              className={cn(
                'px-2.5 py-1 text-[11px] transition-colors',
                openMode === m ? 'bg-primary/20 font-medium text-foreground' : 'text-muted-foreground hover:bg-white/5'
              )}
            >
              {t(m === 'popup' ? 'settings.shortcuts.openModePopup' : 'settings.shortcuts.openModeFloating')}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {drawerShortcut && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2">
            <span className="w-20 shrink-0 text-[13px] text-foreground">{t('settings.shortcuts.drawer')}</span>
            {drawerInConflict && (
              <span
                className="flex items-center gap-1 text-[11px] text-amber-400"
                title={t('settings.shortcuts.conflict')}
              >
                <AlertTriangle className="size-3" /> {t('settings.shortcuts.conflict')}
              </span>
            )}
            <button
              type="button"
              onClick={() => setRecording(recording === 'drawer' ? null : 'drawer')}
              className={cn(
                'ml-auto min-w-24 rounded-md border px-2.5 py-1 text-center font-mono text-[12px] transition-colors',
                recording === 'drawer'
                  ? 'border-primary/60 bg-primary/15 text-foreground'
                  : 'border-border bg-white/[0.02] text-muted-foreground hover:text-foreground'
              )}
            >
              {recording === 'drawer'
                ? t('settings.shortcuts.recording')
                : formatAccelerator(drawerShortcut, shortcutsOs)}
            </button>
          </div>
        )}
        {visibleTabs.map((tab) => {
          const binding = shortcuts[tab]
          const inConflict = conflicts.has(tab)
          const isRec = recording === tab
          return (
            <div
              key={tab}
              className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2"
            >
              <span className="w-20 shrink-0 text-[13px] text-foreground">{t(TOOL_LABEL_KEY[tab])}</span>
              {inConflict && (
                <span
                  className="flex items-center gap-1 text-[11px] text-amber-400"
                  title={t('settings.shortcuts.conflict')}
                >
                  <AlertTriangle className="size-3" /> {t('settings.shortcuts.conflict')}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setRecording(isRec ? null : tab)}
                  className={cn(
                    'min-w-24 rounded-md border px-2.5 py-1 text-center font-mono text-[12px] transition-colors',
                    isRec
                      ? 'border-primary/60 bg-primary/15 text-foreground'
                      : 'border-border bg-white/[0.02] text-muted-foreground hover:text-foreground'
                  )}
                >
                  {isRec
                    ? t('settings.shortcuts.recording')
                    : binding
                      ? formatAccelerator(binding, shortcutsOs)
                      : t('settings.shortcuts.disabled')}
                </button>
                {binding && !isRec && (
                  <button
                    type="button"
                    onClick={() => disableShortcut(tab)}
                    title={t('settings.shortcuts.disable')}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {closeShortcut && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2">
            <span className="shrink-0 text-[13px] text-foreground">{t('settings.shortcuts.closePopup')}</span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {MOD_ORDER_BY_OS[shortcutsOs === 'mac' ? 'mac' : 'pc'].map((m) => {
                const on = closeShortcut.mods.includes(m)
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      const mods = on ? closeShortcut.mods.filter((x) => x !== m) : [...closeShortcut.mods, m]
                      const next: ShortcutBinding = { key: 'escape', mods }
                      setCloseShortcutState(next)
                      window.api.setCloseShortcut(next)
                    }}
                    title={MOD_SYM[m][shortcutsOs === 'mac' ? 'mac' : 'pc']}
                    className={cn(
                      'min-w-7 rounded-md border px-1.5 py-1 text-center font-mono text-[12px] transition-colors',
                      on
                        ? 'border-primary/60 bg-primary/15 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {MOD_SYM[m][shortcutsOs === 'mac' ? 'mac' : 'pc']}
                  </button>
                )
              })}
              <span className="px-1 text-[12px] text-muted-foreground">+</span>
              <span className="rounded-md border border-border bg-white/[0.02] px-2 py-1 text-center font-mono text-[12px] text-foreground">
                Esc
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {recording ? t('settings.shortcuts.recordHint') : t('settings.shortcuts.modsHint')}
        </p>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={resetShortcuts}>
          {t('settings.shortcuts.reset')}
        </Button>
      </div>
    </section>
  )
}
