/** The folders of a host that a person may browse to choose where a workspace lives. */
export interface HostFsRoot {
  path: string
  label: 'home' | 'workspaces'
}

export interface HostFsEntry {
  name: string
  path: string
  /** A `link` points outside the allowed folders, or at something missing: it is shown but cannot be entered. */
  kind: 'directory' | 'file' | 'link'
  size: number
  modifiedAt: number
}

export interface HostFsListing {
  path: string
  /** Null at a root: there is nowhere allowed above it. */
  parent: string | null
  entries: HostFsEntry[]
  truncated: boolean
}

export interface HostFsListOptions {
  includeHidden?: boolean
  includeFiles?: boolean
}

export type HostFsErrorCode = 'outside-roots' | 'not-found' | 'not-a-directory' | 'invalid-name' | 'exists'

/**
 * The fixed message of each refusal. IPC carries an error's message and nothing else of it, so the window tells the
 * refusals apart by their message and says them in the person's language.
 */
export const HOST_FS_ERROR_MESSAGES: Record<HostFsErrorCode, string> = {
  'outside-roots': 'This folder is outside the folders Maestrly can use here.',
  'not-found': 'This folder does not exist.',
  'not-a-directory': 'This is not a folder.',
  'invalid-name': 'This folder name cannot be used.',
  exists: 'A file or folder with this name already exists.',
}

export function hostFsErrorCode(error: unknown): HostFsErrorCode | null {
  const message = error instanceof Error ? error.message : String(error)
  for (const [code, text] of Object.entries(HOST_FS_ERROR_MESSAGES) as Array<[HostFsErrorCode, string]>)
    if (message.includes(text)) return code
  return null
}
