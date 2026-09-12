import { describe, expect, it } from 'vitest'
import { parseLocalFileReference } from '../../src/shared/file-reference'

describe('parseLocalFileReference', () => {
  it.each([
    ['src/chat/view.tsx', { filePath: 'src/chat/view.tsx' }],
    ['app.ts:42', { filePath: 'app.ts', startLine: 42 }],
    ['README.md:L8', { filePath: 'README.md', startLine: 8 }],
    ['src/chat/view.tsx:42', { filePath: 'src/chat/view.tsx', startLine: 42 }],
    ['src/chat/view.tsx:L42', { filePath: 'src/chat/view.tsx', startLine: 42 }],
    ['src/chat/view.tsx:L42-50', { filePath: 'src/chat/view.tsx', startLine: 42, endLine: 50 }],
    ['src/chat/view.tsx#L42', { filePath: 'src/chat/view.tsx', startLine: 42 }],
    ['src/chat/view.tsx#L42-L50', { filePath: 'src/chat/view.tsx', startLine: 42, endLine: 50 }],
    ['/Users/alice/My%20Project/src/view.tsx#L7', { filePath: '/Users/alice/My Project/src/view.tsx', startLine: 7 }],
    ['C:\\repo\\src\\view.tsx:9', { filePath: 'C:\\repo\\src\\view.tsx', startLine: 9 }],
    ['C:/repo/src/view.tsx:9', { filePath: 'C:/repo/src/view.tsx', startLine: 9 }],
    ['./Dockerfile', { filePath: './Dockerfile' }],
    ['.github/CODEOWNERS', { filePath: '.github/CODEOWNERS' }],
  ])('interpreta %s', (input, expected) => {
    expect(parseLocalFileReference(input)).toEqual(expected)
  })

  it.each([
    'https://example.com/src/view.tsx:42',
    'http://example.com/file.ts',
    '//cdn.example.com/file.js',
    'mailto:dev@example.com',
    '#L42',
    'READY/UpToDate',
    'customFiles',
    'src/view.tsx:L50-42',
    'src/view.tsx:0',
    'src/%ZZ/view.tsx',
  ])('does not confuse %s with a valid local reference', (input) => {
    expect(parseLocalFileReference(input)).toBeNull()
  })
})
