import { ipcRenderer } from 'electron'

export type NotesScope = 'conv' | 'project'

export interface PageMeta {
  id: string
  title: string
  emoji?: string
  parentId: string | null
  order: number
}

export type NotesState =
  | { type: 'tree'; scope: NotesScope; id: string; pages: PageMeta[] }
  | { type: 'page'; scope: NotesScope; id: string; pageId: string; content: string; external: boolean }

export type UploadImageResult = { ok: true; relPath: string } | { ok: false; error: string }

export const notesApi = {
  listNotePages: (scope: NotesScope, id: string): Promise<PageMeta[]> => ipcRenderer.invoke('notes:list', scope, id),
  readNotePage: (scope: NotesScope, id: string, pageId: string): Promise<string> =>
    ipcRenderer.invoke('notes:readPage', scope, id, pageId),
  writeNotePage: (scope: NotesScope, id: string, pageId: string, content: string): Promise<void> =>
    ipcRenderer.invoke('notes:writePage', scope, id, pageId, content),
  appendNotePage: (scope: NotesScope, id: string, pageId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('notes:appendPage', scope, id, pageId, text),
  createNotePage: (
    scope: NotesScope,
    id: string,
    args: { title?: string; parentId?: string | null }
  ): Promise<PageMeta | null> => ipcRenderer.invoke('notes:createPage', scope, id, args),
  renameNotePage: (
    scope: NotesScope,
    id: string,
    pageId: string,
    patch: { title?: string; emoji?: string | null }
  ): Promise<void> => ipcRenderer.invoke('notes:renamePage', scope, id, pageId, patch),
  moveNotePage: (
    scope: NotesScope,
    id: string,
    pageId: string,
    parentId: string | null,
    order: number
  ): Promise<void> => ipcRenderer.invoke('notes:movePage', scope, id, pageId, parentId, order),
  deleteNotePage: (scope: NotesScope, id: string, pageId: string): Promise<void> =>
    ipcRenderer.invoke('notes:deletePage', scope, id, pageId),
  mergeNotes: (convId: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('notes:merge', convId),

  uploadNoteImage: (scope: NotesScope, id: string, mime: string, data: ArrayBuffer): Promise<UploadImageResult> =>
    ipcRenderer.invoke('notes:uploadImage', scope, id, mime, data),

  readNoteAsset: (scope: NotesScope, id: string, relPath: string): Promise<string> =>
    ipcRenderer.invoke('notes:readAsset', scope, id, relPath),
  onNotesState: (cb: (s: NotesState) => void) => {
    const listener = (_e: unknown, s: NotesState) => cb(s)
    ipcRenderer.on('drawer:notes-state', listener)
    return () => {
      ipcRenderer.removeListener('drawer:notes-state', listener)
    }
  },
}
