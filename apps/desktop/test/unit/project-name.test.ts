import { describe, expect, it } from 'vitest'
import { isSafeProjectName, suggestProjectName } from '../../src/shared/project-setup'

describe('project name suggestions', () => {
  it.each([
    ['https://github.com/example/project.git', 'project'],
    ['git@github.com:example/project.git', 'project'],
    ['/tmp/remote.git/', 'remote'],
    [String.raw`C:\Users\Example\remote.git`, 'remote'],
    [String.raw`\\server\share\project.git`, 'project'],
  ])('suggests a portable directory name from %s', (url, expected) => {
    const name = suggestProjectName(url)
    expect(name).toBe(expected)
    expect(isSafeProjectName(name)).toBe(true)
  })
})
