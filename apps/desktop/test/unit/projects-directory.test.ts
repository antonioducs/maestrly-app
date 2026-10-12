import { afterEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => settings.get(key),
  setAppSetting: (key: string, value: string) => void settings.set(key, value),
}))

const { getProjectsDirectory, PROJECTS_DIRECTORY_KEY, setProjectsDirectoryFallback } = await import(
  '../../src/main/projects-directory'
)

afterEach(() => {
  settings.clear()
  setProjectsDirectoryFallback(null)
})

describe('projects folder', () => {
  it('is unset until the owner chooses one', () => {
    expect(getProjectsDirectory()).toBeNull()
    settings.set(PROJECTS_DIRECTORY_KEY, '  /home/owner/projects  ')
    expect(getProjectsDirectory()).toBe('/home/owner/projects')
  })

  it("falls back to a server's workspaces folder only while the owner chose none", () => {
    setProjectsDirectoryFallback('/srv/maestrly')
    expect(getProjectsDirectory()).toBe('/srv/maestrly')
    settings.set(PROJECTS_DIRECTORY_KEY, '/srv/maestrly/clients')
    expect(getProjectsDirectory()).toBe('/srv/maestrly/clients')
    // Clearing the choice stores an empty value: the server's folder applies again.
    settings.set(PROJECTS_DIRECTORY_KEY, '')
    expect(getProjectsDirectory()).toBe('/srv/maestrly')
  })
})
