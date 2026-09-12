import {
  listPages,
  readPage,
  writePage,
  appendPage,
  createPage,
  renamePage,
  movePage,
  deletePage,
  mergeConvIntoProject,
  uploadNoteImage,
  readNoteAsset,
  type NotesScope,
} from './notes-service'
import type { IpcRegistrar } from '../ipc-registrar'

export function registerNotesIpc(reg: IpcRegistrar): void {
  // Nested conversation and project notebooks at their respective notes directories.
  reg.handle('notes:list', (_e, scope: NotesScope, id: string) => listPages(scope, id))
  reg.handle('notes:readPage', (_e, scope: NotesScope, id: string, pageId: string) => readPage(scope, id, pageId))
  reg.mhandle('notes:writePage', (_e, scope: NotesScope, id: string, pageId: string, content: string) =>
    writePage(scope, id, pageId, content)
  )
  reg.mhandle('notes:appendPage', (_e, scope: NotesScope, id: string, pageId: string, text: string) =>
    appendPage(scope, id, pageId, text)
  )
  reg.mhandle(
    'notes:createPage',
    (_e, scope: NotesScope, id: string, args: { title?: string; parentId?: string | null }) =>
      createPage(scope, id, args)
  )
  reg.mhandle(
    'notes:renamePage',
    (_e, scope: NotesScope, id: string, pageId: string, patch: { title?: string; emoji?: string | null }) =>
      renamePage(scope, id, pageId, patch)
  )
  reg.mhandle(
    'notes:movePage',
    (_e, scope: NotesScope, id: string, pageId: string, parentId: string | null, order: number) =>
      movePage(scope, id, pageId, parentId, order)
  )
  reg.mhandle('notes:deletePage', (_e, scope: NotesScope, id: string, pageId: string) => deletePage(scope, id, pageId))
  reg.mhandle('notes:merge', (_e, convId: string) => mergeConvIntoProject(convId))
  // Note images (#22): persist assets and read them as display data URLs.
  reg.mhandle('notes:uploadImage', (_e, scope: NotesScope, id: string, mime: string, data: ArrayBuffer) =>
    uploadNoteImage(scope, id, mime, data)
  )
  reg.handle('notes:readAsset', (_e, scope: NotesScope, id: string, relPath: string) =>
    readNoteAsset(scope, id, relPath)
  )
}
