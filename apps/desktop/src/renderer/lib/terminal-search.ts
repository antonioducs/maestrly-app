import type { ISearchOptions } from '@xterm/addon-search'

interface SearchShortcutEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export const TERMINAL_SEARCH_OPTIONS: ISearchOptions = {
  incremental: true,
  decorations: {
    matchBackground: '#343B45',
    matchBorder: '#77808E',
    matchOverviewRuler: '#77808E',
    activeMatchBackground: '#59616C',
    activeMatchBorder: '#EDEAE3',
    activeMatchColorOverviewRuler: '#EDEAE3',
  },
}

export function isTerminalSearchShortcut(event: SearchShortcutEvent, os: 'mac' | 'win' | 'linux'): boolean {
  if (event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey) return false
  return os === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
