import { ipcRenderer } from 'electron'
import type { FloatTab } from '../shared/tool-tabs'

export interface PopupSlot {
  tab: FloatTab

  frame: { x: number; y: number; width: number; height: number }

  chromeTop: number

  browserChromeH: number
}

export interface PopupState {
  convId: string | null
  stack: PopupSlot[]
  suppressed: boolean
}

export const popupApi = {
  popupOpen: (convId: string, tab: FloatTab) => ipcRenderer.send('popup:open', convId, tab),

  popupOpenFloating: (convId: string, tab: FloatTab) => ipcRenderer.send('popup:open-floating', convId, tab),

  popupClose: (convId: string, tab: FloatTab) => ipcRenderer.send('popup:close', convId, tab),

  popupCloseTop: (convId: string) => ipcRenderer.send('popup:close-top', convId),

  popupSetSuppressed: (on: boolean) => ipcRenderer.send('popup:set-suppressed', on),

  onPopupState: (cb: (s: PopupState) => void): (() => void) => {
    const listener = (_e: unknown, s: PopupState) => cb(s)
    ipcRenderer.on('popup:state', listener)
    return () => ipcRenderer.removeListener('popup:state', listener)
  },

  getPopupState: (convId: string): Promise<PopupState> => ipcRenderer.invoke('popup:state-get', convId),
}
