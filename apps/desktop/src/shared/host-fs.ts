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
