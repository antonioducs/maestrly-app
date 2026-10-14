import { describe, expect, it } from 'vitest'
import { imageLabel, safeLink } from '../src/ui/links'

describe('links in replies', () => {
  it('opens only web pages and email', () => {
    expect(safeLink('https://example.dev/a?b=1#c')).toBe('https://example.dev/a?b=1#c')
    expect(safeLink(' http://example.dev ')).toBe('http://example.dev/')
    expect(safeLink('mailto:team@example.dev')).toBe('mailto:team@example.dev')
    for (const href of [
      'maestrly://pair?server=https://evil.example&code=ABCD-EFGH',
      'tel:+15550100',
      'sms:+15550100',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,hi',
      '/relative/path',
      'https://user:secret@example.dev',
      '',
    ])
      expect(safeLink(href)).toBeNull()
  })

  it('names an image by its description, else by its host', () => {
    expect(imageLabel('https://cdn.example.dev/a.png', 'Chart')).toBe('Chart')
    expect(imageLabel('https://cdn.example.dev/a.png', '', 'Title')).toBe('Title')
    expect(imageLabel('https://cdn.example.dev/a.png')).toBe('cdn.example.dev')
    expect(imageLabel('not a url')).toBe('not a url')
  })
})
