import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getAppSetting, setAppSetting } from './store'

/** Folder where chats create and clone projects, and the project setup dialog's default parent folder. */
export const PROJECTS_DIRECTORY_KEY = 'projects.directory'

let fallbackDirectory: string | null = null

/**
 * The folder used while the owner has chosen none. Server mode sets the server's workspaces folder: nobody can answer
 * a folder picker there, and projects created in it outlive the container.
 */
export function setProjectsDirectoryFallback(value: string | null): void {
  fallbackDirectory = value
}

export function getProjectsDirectory(): string | null {
  const value = getAppSetting(PROJECTS_DIRECTORY_KEY)?.trim()
  return value ? value : fallbackDirectory
}

/** Persist an existing absolute directory, resolved through symlinks; null clears the setting. */
export async function setProjectsDirectory(value: string | null): Promise<string | null> {
  if (value === null || !value.trim()) {
    setAppSetting(PROJECTS_DIRECTORY_KEY, '')
    return null
  }
  if (value.includes('\0') || !path.isAbsolute(value)) throw new Error('The projects folder must be an absolute path.')
  const real = await fs.realpath(value)
  if (!(await fs.stat(real)).isDirectory()) throw new Error('The projects folder must be a directory.')
  setAppSetting(PROJECTS_DIRECTORY_KEY, real)
  return real
}
